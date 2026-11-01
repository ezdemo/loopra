package plugin

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

// Update fetches the original source again. npm updates use latest; GitHub
// keeps the selected ref and subdirectory, and local sources are copied again.
func (h *Host) Update(ctx context.Context, id string) (View, error) {
	if h.home == "" {
		return View{}, errNoHome
	}
	if !safeID(id) {
		return View{}, errMissing(id)
	}
	h.op.Lock()
	defer h.op.Unlock()
	rec, exists := h.pluginRecord(id)
	if !exists {
		return View{}, errMissing(id)
	}
	if rec.Builtin {
		return View{}, errText("内置插件随应用更新")
	}
	src, err := parseSource(rec.Source)
	if err != nil {
		return View{}, err
	}
	if src.Kind == "npm" {
		src.Version = "latest"
	}
	stage, err := os.MkdirTemp(h.base(), ".stage-")
	if err != nil {
		return View{}, err
	}
	defer os.RemoveAll(stage)
	info, err := h.materialize(ctx, src, stage)
	if err != nil {
		return View{}, err
	}
	return h.replacePackage(ctx, rec, info, rec.Source, stage)
}

// replacePackage keeps configuration, data, installation order and enabled
// state. The previous files and runtime survive a failed update.
// The caller holds h.op and owns stage.
func (h *Host) replacePackage(ctx context.Context, previous record, info pkgFile, source, stage string) (View, error) {
	if info.Name != previous.Name || pluginID(info.Name) != previous.ID {
		return View{}, fmt.Errorf("更新包名不匹配: 期望 %s，实际 %s", previous.Name, info.Name)
	}
	rec := previous
	rec.DisplayName = info.Name
	rec.Description = info.Description
	rec.Version = info.Version
	rec.Entry = info.Entry
	rec.Source = source

	backup, err := os.MkdirTemp(h.base(), ".backup-")
	if err != nil {
		return View{}, err
	}
	if err := os.Remove(backup); err != nil {
		return View{}, err
	}
	dest := h.pkgDir(rec.ID)
	hadFiles := false
	if err := os.Rename(dest, backup); err == nil {
		hadFiles = true
	} else if !os.IsNotExist(err) {
		return View{}, err
	}
	rollback := func(cause error) (View, error) {
		if _, err := os.Stat(dest); err == nil {
			if err := os.Rename(dest, stage); err != nil {
				return View{}, errors.Join(cause, fmt.Errorf("移除更新文件失败: %w", err))
			}
		}
		if hadFiles {
			if err := os.Rename(backup, dest); err != nil {
				return View{}, errors.Join(cause, fmt.Errorf("恢复旧版失败: %w", err))
			}
		}
		return View{}, cause
	}
	if err := os.Rename(stage, dest); err != nil {
		// stage still exists; only the previous directory needs restoring.
		if hadFiles {
			err = errors.Join(err, os.Rename(backup, dest))
		}
		return View{}, err
	}
	run, err := openPackage(ctx, dest, rec)
	if err == nil {
		err = run.setHostServices(h.services, readPkg(dest).Services, h.dataDir(rec.ID))
		if err != nil {
			run.close()
		}
	}
	if err != nil {
		return rollback(err)
	}
	if err := h.activate(rec, run); err != nil {
		return rollback(err)
	}
	if hadFiles {
		if err := os.RemoveAll(backup); err != nil {
			// The update is committed; a leftover backup must not report failure.
			logging.Warnf("plugin", "清理 %s 旧版失败: %v", rec.ID, err)
		}
	}
	return h.view(rec.ID), nil
}
