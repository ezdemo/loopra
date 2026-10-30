package controller

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/ezdemo/looprax/internal/repository"
)

const uiPreferencesFile = "ui-preferences.json"

// uiPreferences 是还没有单独接口的工作台设置。主题用 light、dark、system，
// 语言用 zh、en。个人资料、宠物开关和隐藏会话缺省时不写出，便于区分
// 「还没保存过」和「保存成空」。persisted 只出现在响应里，表示文件是否已经写过。
type uiPreferences struct {
	Theme          string     `json:"theme"`
	Language       string     `json:"language"`
	FontScale      int        `json:"fontScale"`
	Notifications  bool       `json:"notifications"`
	Sound          bool       `json:"sound"`
	OpenWith       string     `json:"openWith"`
	AutoContext    bool       `json:"autoContext"`
	Animations     bool       `json:"animations"`
	PetEnabled     *bool      `json:"petEnabled,omitempty"`
	HiddenSessions *[]string  `json:"hiddenSessions,omitempty"`
	Profile        *uiProfile `json:"profile,omitempty"`
	Persisted      bool       `json:"persisted"`
}

type uiProfile struct {
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
	Color    string `json:"color"`
}

func defaultUIPreferences() uiPreferences {
	return uiPreferences{
		Theme: "light", Language: "zh", FontScale: 100,
		Notifications: true, Sound: true, OpenWith: "File Explorer",
		AutoContext: true, Animations: true,
	}
}

func (s *Controller) uiPreferencesPath() string {
	return filepath.Join(s.home, uiPreferencesFile)
}

// SavedUITheme 读取已保存的外观。没有记录时返回空字符串。
func SavedUITheme(home string) string {
	prefs, ok := loadUIPreferences(filepath.Join(home, uiPreferencesFile))
	if !ok {
		return ""
	}
	return prefs.Theme
}

func loadUIPreferences(path string) (uiPreferences, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return defaultUIPreferences(), false
	}
	prefs := defaultUIPreferences()
	if json.Unmarshal(data, &prefs) != nil {
		return defaultUIPreferences(), false
	}
	if prefs.Theme = canonicalTheme(prefs.Theme); prefs.Theme == "" {
		prefs.Theme = "light"
	}
	if prefs.Language = canonicalLanguage(prefs.Language); prefs.Language == "" {
		prefs.Language = "zh"
	}
	if !validFontScale(prefs.FontScale) {
		prefs.FontScale = 100
	}
	prefs.OpenWith = strings.TrimSpace(prefs.OpenWith)
	if prefs.OpenWith == "" {
		prefs.OpenWith = defaultUIPreferences().OpenWith
	}
	prefs.Persisted = false
	return prefs, true
}

func (s *Controller) uiPreferences(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.uiPreferencesMu.Lock()
		prefs, ok := loadUIPreferences(s.uiPreferencesPath())
		s.uiPreferencesMu.Unlock()
		prefs.Persisted = ok
		writeOK(w, http.StatusOK, prefs)
	case http.MethodPut:
		var patch map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil || patch == nil {
			writeFail(w, http.StatusBadRequest, "配置格式不正确")
			return
		}
		s.uiPreferencesMu.Lock()
		defer s.uiPreferencesMu.Unlock()
		current, _ := loadUIPreferences(s.uiPreferencesPath())
		if err := current.apply(patch); err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		current.Persisted = false
		if err := repository.WriteJSON(s.uiPreferencesPath(), current); err != nil {
			writeFail(w, http.StatusInternalServerError, "设置保存失败")
			return
		}
		s.syncDesktopTheme(current.Theme)
		if s.onUITheme != nil {
			s.onUITheme(current.Theme)
		}
		current.Persisted = true
		writeOK(w, http.StatusOK, current)
	default:
		w.Header().Set("Allow", "GET, HEAD, PUT")
		writeFail(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (p *uiPreferences) apply(patch map[string]json.RawMessage) error {
	if raw, ok := patch["theme"]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("无效的外观")
		}
		theme := canonicalTheme(value)
		if theme == "" {
			return errors.New("无效的外观")
		}
		p.Theme = theme
	}
	if raw, ok := patch["language"]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("无效的语言")
		}
		language := canonicalLanguage(value)
		if language == "" {
			return errors.New("无效的语言")
		}
		p.Language = language
	}
	if raw, ok := patch["fontScale"]; ok {
		scale, ok := scaleFromJSON(raw)
		if !ok || !validFontScale(scale) {
			return errors.New("无效的界面缩放")
		}
		p.FontScale = scale
	}
	for _, field := range []struct {
		key    string
		target *bool
	}{
		{"notifications", &p.Notifications},
		{"sound", &p.Sound},
		{"autoContext", &p.AutoContext},
		{"animations", &p.Animations},
	} {
		raw, ok := patch[field.key]
		if !ok {
			continue
		}
		var value bool
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("配置格式不正确")
		}
		*field.target = value
	}
	if raw, ok := patch["openWith"]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil || !validOpenWith(value) {
			return errors.New("无效的默认打开应用")
		}
		p.OpenWith = strings.TrimSpace(value)
	}
	if raw, ok := patch["petEnabled"]; ok {
		var value bool
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("配置格式不正确")
		}
		p.PetEnabled = &value
	}
	if raw, ok := patch["hiddenSessions"]; ok {
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			return errors.New("无效的隐藏会话")
		}
		normalized, ok := normalizeHiddenSessions(ids)
		if !ok {
			return errors.New("无效的隐藏会话")
		}
		p.HiddenSessions = &normalized
	}
	if raw, ok := patch["profile"]; ok {
		var profile uiProfile
		if json.Unmarshal(raw, &profile) != nil || !validProfile(&profile) {
			return errors.New("无效的个人资料")
		}
		p.Profile = &profile
	}
	return nil
}

var profileColors = map[string]bool{"blue": true, "violet": true, "rose": true, "amber": true, "green": true, "slate": true}
var profileAvatar = regexp.MustCompile(`^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$`)

func validProfile(profile *uiProfile) bool {
	profile.Nickname = strings.TrimSpace(profile.Nickname)
	if utf8.RuneCountInString(profile.Nickname) > 32 {
		return false
	}
	if profile.Color == "" {
		profile.Color = "blue"
	}
	if !profileColors[profile.Color] {
		return false
	}
	if profile.Avatar == "" {
		return true
	}
	return len(profile.Avatar) <= 400_000 && profileAvatar.MatchString(profile.Avatar)
}

func normalizeHiddenSessions(ids []string) ([]string, bool) {
	if len(ids) > 500 {
		return nil, false
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || utf8.RuneCountInString(id) > 240 || strings.ContainsAny(id, "\r\n\x00") {
			return nil, false
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, true
}

func canonicalTheme(value string) string {
	switch strings.TrimSpace(value) {
	case "light", "浅色":
		return "light"
	case "dark", "深色":
		return "dark"
	case "system", "跟随系统":
		return "system"
	default:
		return ""
	}
}

func canonicalLanguage(value string) string {
	switch strings.TrimSpace(value) {
	case "zh", "简体中文":
		return "zh"
	case "en", "English":
		return "en"
	default:
		return ""
	}
}

func validFontScale(scale int) bool {
	switch scale {
	case 80, 90, 100, 110, 120:
		return true
	default:
		return false
	}
}

func scaleFromJSON(raw json.RawMessage) (int, bool) {
	var number float64
	if json.Unmarshal(raw, &number) != nil || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
		return 0, false
	}
	return int(number), true
}

func validOpenWith(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 80 {
		return false
	}
	return !strings.ContainsAny(value, "\r\n\x00")
}

// syncDesktopTheme 把旧桌面壳读取的 desktop.json 主题改成同一值。
// 文件不存在时不创建，避免凭空写出一份窗口几何配置。
func (s *Controller) syncDesktopTheme(theme string) {
	path := filepath.Join(s.home, "desktop.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var doc map[string]any
	if json.Unmarshal(data, &doc) != nil || doc == nil {
		return
	}
	if doc["theme"] == theme {
		return
	}
	doc["theme"] = theme
	_ = repository.WriteJSON(path, doc)
}
