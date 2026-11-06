package controller

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	"github.com/ezdemo/looprax/internal/service/bot"
	qrcode "github.com/skip2/go-qrcode"
)

func (s *Controller) botsController(w http.ResponseWriter, r *http.Request) {
	if s.bots == nil {
		writeFail(w, http.StatusServiceUnavailable, "Bot 服务未启用")
		return
	}
	id := r.PathValue("id")
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		writeOK(w, http.StatusOK, s.bots.List())
	case http.MethodPut:
		var input bot.Update
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
			writeFail(w, http.StatusBadRequest, "Bot 配置格式不正确")
			return
		}
		view, err := s.bots.Update(id, input)
		if err != nil {
			writeBotError(w, err)
			return
		}
		writeOK(w, http.StatusOK, view)
	case http.MethodDelete:
		if err := s.bots.Delete(id); err != nil {
			writeBotError(w, err)
			return
		}
		writeOK(w, http.StatusOK, "Bot 已删除，项目和会话已保留")
	}
}

func (s *Controller) botRegistrationController(w http.ResponseWriter, r *http.Request) {
	if s.bots == nil {
		writeFail(w, http.StatusServiceUnavailable, "Bot 服务未启用")
		return
	}
	var reg bot.Registration
	var err error
	switch r.Method {
	case http.MethodPost:
		var input struct {
			Name  string `json:"name"`
			BotID string `json:"botId"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
			writeFail(w, http.StatusBadRequest, "授权请求格式不正确")
			return
		}
		reg, err = s.bots.BeginRegistration(input.Name, input.BotID)
	case http.MethodGet, http.MethodHead:
		reg, err = s.bots.Registration(r.PathValue("id"))
	case http.MethodDelete:
		if err := s.bots.CancelRegistration(r.PathValue("id")); err != nil {
			writeBotError(w, err)
			return
		}
		writeOK(w, http.StatusOK, "已取消授权")
		return
	}
	if err != nil {
		writeBotError(w, err)
		return
	}
	response := struct {
		bot.Registration
		QRCode string `json:"qrCode,omitempty"`
	}{Registration: reg}
	if reg.State == "waiting" && reg.URL != "" {
		png, err := qrcode.Encode(reg.URL, qrcode.Low, 320)
		if err != nil {
			writeFail(w, http.StatusInternalServerError, "生成二维码失败")
			return
		}
		response.QRCode = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeOK(w, http.StatusOK, response)
}

func writeBotError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	reason, message := "invalid_bot_request", err.Error()
	if errors.Is(err, bot.ErrNotFound) {
		status, reason = http.StatusNotFound, "bot_not_found"
	} else if errors.Is(err, bot.ErrClosed) {
		status, reason = http.StatusServiceUnavailable, "bot_unavailable"
	} else if errors.Is(err, bot.ErrStorage) {
		status, reason, message = http.StatusInternalServerError, "bot_storage_failed", bot.ErrStorage.Error()
		logging.Warnf("bot", "configuration operation failed: %v", err)
	}
	writeFailReason(w, status, message, reason)
}

// PrepareBotProject 创建固定目录及项目记录，不改变当前工作台选中的项目。
func (s *Controller) PrepareBotProject(ctx context.Context, id string) (string, error) {
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if len(id) != 24 || filepath.Base(id) != id {
		return "", fmt.Errorf("无效的 Bot ID")
	}
	path := filepath.Join(s.home, "bot-projects", id)
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	hash := service.WorkspaceHash(path)
	s.state.files.Lock()
	defer s.state.files.Unlock()
	file := filepath.Join(s.home, "workspace", hash, "workspace.json")
	data, err := os.ReadFile(file)
	if err == nil {
		var existing map[string]any
		if err := json.Unmarshal(data, &existing); err != nil {
			return "", err
		}
		if existing["path"] != path {
			return "", fmt.Errorf("Bot 项目目录不匹配")
		}
		return hash, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	if err := repository.WriteJSON(file, map[string]any{
		"path": path, "displayName": "Bot-飞书-" + id[:5],
		"createdAt": time.Now().UnixMilli(), "lastAccessedAt": time.Now().UnixMilli(),
	}); err != nil {
		return "", err
	}
	return hash, nil
}

func (s *Controller) RunBotTurn(ctx context.Context, hash, session, message string) (string, error) {
	view, err := s.projectRuntime(hash)
	if err != nil {
		return "", err
	}
	if bound := strOr(view.sessionMetaRead(session), "agentId", "native"); bound != "native" {
		return "", fmt.Errorf("Bot 会话需使用 Loopra Native")
	}
	return view.runTurnQuiet(ctx, session, message)
}
