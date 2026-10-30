package controller

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUIPreferencesRoundTrip(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "desktop.json"), []byte("{\n  \"theme\" : \"light\",\n  \"windowWidth\" : 1280.0\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var applied []string
	s := &Controller{home: home, onUITheme: func(theme string) { applied = append(applied, theme) }}

	first := callUIPreferences(t, s, http.MethodGet, nil)
	if first.StatusCode != http.StatusOK || first.prefs.Persisted || first.prefs.Theme != "light" {
		t.Fatalf("missing file = %d %+v", first.StatusCode, first.prefs)
	}

	saved := callUIPreferences(t, s, http.MethodPut, []byte(`{"theme":"深色","language":"English","fontScale":110,"notifications":false,"sound":true,"openWith":"Terminal","autoContext":false,"animations":true}`))
	if saved.StatusCode != http.StatusOK || !saved.prefs.Persisted || saved.prefs.Theme != "dark" || saved.prefs.Language != "en" || saved.prefs.FontScale != 110 || saved.prefs.Notifications || saved.prefs.OpenWith != "Terminal" || saved.prefs.AutoContext {
		t.Fatalf("save = %d %+v", saved.StatusCode, saved.prefs)
	}
	if strings.Join(applied, ",") != "dark" {
		t.Fatalf("theme callback = %v", applied)
	}
	disk, err := os.ReadFile(filepath.Join(home, "desktop.json"))
	if err != nil {
		t.Fatal(err)
	}
	var desktop map[string]any
	if json.Unmarshal(disk, &desktop) != nil || desktop["theme"] != "dark" || desktop["windowWidth"] != 1280.0 {
		t.Fatalf("desktop.json = %s", disk)
	}

	again := callUIPreferences(t, s, http.MethodGet, nil)
	if !again.prefs.Persisted || again.prefs.Theme != "dark" || again.prefs.Sound != true {
		t.Fatalf("reload = %+v", again.prefs)
	}

	partial := callUIPreferences(t, s, http.MethodPut, []byte(`{"theme":"跟随系统"}`))
	if partial.prefs.Theme != "system" || partial.prefs.Language != "en" || partial.prefs.FontScale != 110 {
		t.Fatalf("partial update dropped fields: %+v", partial.prefs)
	}

	rejected := callUIPreferences(t, s, http.MethodPut, []byte(`{"theme":"sepia"}`))
	if rejected.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid theme status = %d", rejected.StatusCode)
	}
	if got := callUIPreferences(t, s, http.MethodGet, nil); got.prefs.Theme != "system" {
		t.Fatalf("rejected write changed theme to %s", got.prefs.Theme)
	}
}

func TestUIPreferencesRouteRequiresSavedFile(t *testing.T) {
	ts, key := newTestServer(t)
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/ui-preferences", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Loopra-Key", key)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var body struct {
		Success bool `json:"success"`
		Data    struct {
			Persisted bool   `json:"persisted"`
			Theme     string `json:"theme"`
		} `json:"data"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil || !body.Success || body.Data.Persisted || body.Data.Theme != "light" {
		t.Fatalf("route response = %+v", body)
	}
}

func TestUIPreferencesKeepsProfilePetAndHiddenSessions(t *testing.T) {
	s := &Controller{home: t.TempDir()}
	saved := callUIPreferences(t, s, http.MethodPut, []byte(`{"theme":"dark","petEnabled":true,"hiddenSessions":["d0ab4c2fbf56/loopra-1","d0ab4c2fbf56/loopra-1"],"profile":{"nickname":" 小环 ","avatar":"","color":"rose"}}`))
	if saved.StatusCode != http.StatusOK || saved.prefs.Profile == nil || saved.prefs.Profile.Nickname != "小环" || saved.prefs.Profile.Color != "rose" || saved.prefs.PetEnabled == nil || !*saved.prefs.PetEnabled {
		t.Fatalf("save = %d %+v", saved.StatusCode, saved.prefs)
	}
	if saved.prefs.HiddenSessions == nil || len(*saved.prefs.HiddenSessions) != 1 || (*saved.prefs.HiddenSessions)[0] != "d0ab4c2fbf56/loopra-1" {
		t.Fatalf("hidden = %#v", saved.prefs.HiddenSessions)
	}
	kept := callUIPreferences(t, s, http.MethodPut, []byte(`{"theme":"light"}`))
	if kept.prefs.Theme != "light" || kept.prefs.Profile == nil || kept.prefs.Profile.Nickname != "小环" || kept.prefs.PetEnabled == nil || !*kept.prefs.PetEnabled {
		t.Fatalf("partial update dropped settings: %+v", kept.prefs)
	}
	rejected := callUIPreferences(t, s, http.MethodPut, []byte(`{"profile":{"nickname":"a","avatar":"javascript:alert(1)","color":"blue"}}`))
	if rejected.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid avatar status = %d", rejected.StatusCode)
	}
}

func TestSavedUITheme(t *testing.T) {
	home := t.TempDir()
	if SavedUITheme(home) != "" {
		t.Fatal("missing file should not invent a theme")
	}
	if err := os.WriteFile(filepath.Join(home, uiPreferencesFile), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if SavedUITheme(home) != "dark" {
		t.Fatalf("saved theme = %q", SavedUITheme(home))
	}
}

type uiPreferenceResponse struct {
	StatusCode int
	prefs      uiPreferences
}

func callUIPreferences(t *testing.T, s *Controller, method string, body []byte) uiPreferenceResponse {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader(body)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, "/api/ui-preferences", reader)
	s.uiPreferences(rec, req)
	var envelope struct {
		Success bool          `json:"success"`
		Data    uiPreferences `json:"data"`
	}
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil || !envelope.Success {
			t.Fatalf("response %d %s", rec.Code, rec.Body.Bytes())
		}
	}
	return uiPreferenceResponse{StatusCode: rec.Code, prefs: envelope.Data}
}
