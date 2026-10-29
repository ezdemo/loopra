package controller

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/ezdemo/looprax/internal/repository"
)

// promptPresetsController 提供 ~/.loopra/prompt-presets.json。
func (s *Controller) promptPresetsController(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.home, "prompt-presets.json")
	switch r.Method {
	case http.MethodGet:
		data, err := os.ReadFile(path)
		if err != nil {
			writeOK(w, http.StatusOK, []any{})
			return
		}
		var presets []map[string]any
		_ = json.Unmarshal(data, &presets)
		writeOK(w, http.StatusOK, presets)
	case http.MethodPut:
		var body struct {
			Presets []map[string]any `json:"presets"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeFail(w, http.StatusBadRequest, "格式不正确")
			return
		}
		if body.Presets == nil {
			writeFail(w, http.StatusOK, "预设数据格式不正确")
			return
		}
		for _, preset := range body.Presets {
			label, _ := preset["label"].(string)
			text, _ := preset["text"].(string)
			label, text = strings.TrimSpace(label), strings.TrimSpace(text)
			if label == "" || text == "" {
				writeFail(w, http.StatusOK, "预设名称和要求内容不能为空")
				return
			}
			if len(utf16.Encode([]rune(label))) > 24 || len(utf16.Encode([]rune(text))) > 500 {
				writeFail(w, http.StatusOK, "预设名称或要求内容过长")
				return
			}
			preset["label"], preset["text"] = label, text
			if id, _ := preset["id"].(string); strings.TrimSpace(id) == "" {
				preset["id"] = newUUIDv4()
			}
		}
		if err := repository.WriteJSON(path, body.Presets); err != nil {
			writeFail(w, http.StatusOK, "保存常用要求失败: "+err.Error())
			return
		}
		writeOK(w, http.StatusOK, body.Presets)
	}
}
