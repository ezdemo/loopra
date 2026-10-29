package controller

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ezdemo/looprax/internal/repository"
)

// petsDir 为 ~/.loopra/pets/<name>/，其中每个宠物包含 pets.json 元数据
// 和一个 spritesheet.webp。
func (s *Controller) petsDir() string {
	return s.petsPath
}

func (s *Controller) petMeta(name string) (map[string]any, bool) {
	if !validPetName(name) {
		return nil, false
	}
	if info, err := os.Stat(filepath.Join(s.petsDir(), name)); err != nil || !info.IsDir() {
		return nil, false
	}
	meta := repository.ReadObject(filepath.Join(s.petsDir(), name, "pet.json"))
	meta["dirName"] = name
	return meta, true
}

func validPetName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	for _, r := range name {
		if r < 32 || strings.ContainsRune(`/\:`, r) {
			return false
		}
	}
	return true
}

// petsController 实现 /api/pets 相关的接口（§3.17）。
func (s *Controller) petsController(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/pets"), "/")
	name, sub := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		name, sub = rest[:i], rest[i+1:]
	}
	switch {
	case rest == "":
		s.petsList(w)
	case rest == "active":
		s.petsActive(w, r)
	case rest == "position" && r.Method == http.MethodPut:
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body == nil {
			writeFail(w, http.StatusBadRequest, "位置格式不正确")
			return
		}
		s.state.files.Lock()
		path := filepath.Join(s.home, "pet", "position.json")
		position := repository.ReadObject(path)
		for _, key := range []string{"x", "y", "sizeIndex"} {
			if value, ok := body[key]; ok {
				position[key] = value
			}
		}
		if raw, ok := body["scale"]; ok {
			if scale, valid := petScale(raw); valid {
				position["scale"] = scale
			}
		}
		err := repository.WriteJSON(path, position)
		s.state.files.Unlock()
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, "位置已保存")
	case sub == "spritesheet":
		s.petSpritesheet(w, r, name)
	case sub == "" && r.Method == http.MethodDelete:
		if !validPetName(name) {
			writeFail(w, http.StatusBadRequest, "非法名称")
			return
		}
		if _, ok := s.petMeta(name); !ok {
			writeFail(w, http.StatusOK, "宠物不存在: "+name)
			return
		}
		if err := os.RemoveAll(filepath.Join(s.petsDir(), name)); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if s.cfg.ActivePet == name {
			if err := s.saveConfig(map[string]any{"activePet": ""}); err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		writeOK(w, http.StatusOK, "宠物已删除: "+name)
	case sub == "":
		meta, ok := s.petMeta(name)
		if !ok {
			writeFail(w, http.StatusOK, "宠物不存在: "+name)
			return
		}
		if _, err := os.Stat(filepath.Join(s.petsDir(), name, "pet.json")); os.IsNotExist(err) {
			writeOK(w, http.StatusOK, "{}")
			return
		}
		writeOK(w, http.StatusOK, meta)
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func (s *Controller) petsList(w http.ResponseWriter) {
	out := []map[string]any{}
	entries, err := os.ReadDir(s.petsDir())
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if meta, ok := s.petMeta(e.Name()); ok {
				display, _ := meta["name"].(string)
				if display == "" {
					display = e.Name()
				}
				description, _ := meta["description"].(string)
				_, sheetErr := os.Stat(filepath.Join(s.petsDir(), e.Name(), "spritesheet.webp"))
				view := map[string]any{"name": e.Name(), "dirName": e.Name(), "displayName": display, "description": description, "hasSpritesheet": sheetErr == nil, "spritesheetUrl": "/api/pets/" + e.Name() + "/spritesheet"}
				if author, ok := meta["author"]; ok {
					view["author"] = author
				}
				out = append(out, view)
			}
		}
	}
	writeOK(w, http.StatusOK, out)
}

func (s *Controller) petsActive(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPut:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
			writeFail(w, http.StatusOK, "宠物名称不能为空")
			return
		}
		if _, ok := s.petMeta(body.Name); !ok {
			writeFail(w, http.StatusOK, "宠物不存在: "+body.Name)
			return
		}
		if err := s.saveConfig(map[string]any{"activePet": body.Name}); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeOK(w, http.StatusOK, "已切换到宠物: "+body.Name)
	default:
		meta, ok := s.petMeta(s.cfg.ActivePet)
		if !ok {
			writeOK(w, http.StatusOK, map[string]any{"active": false})
			return
		}
		position := repository.ReadObject(filepath.Join(s.home, "pet", "position.json"))
		display, _ := meta["name"].(string)
		if display == "" {
			display = s.cfg.ActivePet
		}
		view := map[string]any{"active": true, "name": s.cfg.ActivePet, "displayName": display, "description": meta["description"], "position": map[string]any{"x": number(position["x"]), "y": number(position["y"])}, "sizeIndex": 1, "spritesheetUrl": "/api/pets/" + s.cfg.ActivePet + "/spritesheet"}
		if size, ok := position["sizeIndex"]; ok {
			view["sizeIndex"] = number(size)
		}
		if scale, ok := petScale(position["scale"]); ok {
			view["scale"] = scale
		}
		writeOK(w, http.StatusOK, view)
	}
}

// petSpritesheet 流式返回 webp 精灵图；访问过滤器已针对
// 该路径形态接受 ?rk= 参数。
func (s *Controller) petSpritesheet(w http.ResponseWriter, r *http.Request, name string) {
	if !validPetName(name) {
		writeFail(w, http.StatusBadRequest, "非法名称")
		return
	}
	path := filepath.Join(s.petsDir(), name, "spritesheet.webp")
	if _, err := os.Stat(path); err != nil {
		writeFail(w, http.StatusNotFound, "宠物不存在: "+name)
		return
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, path)
}

func petScale(raw any) (float64, bool) {
	value, ok := raw.(float64)
	if text, stringValue := raw.(string); stringValue {
		var err error
		value, err = strconv.ParseFloat(text, 64)
		ok = err == nil
	}
	return value, ok && !math.IsInf(value, 0) && !math.IsNaN(value) && value >= 0.25 && value <= 1.25
}
