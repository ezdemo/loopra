package controller

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestSystemHealthUsesAPIResponseWrapper(t *testing.T) {
	oldVersion, oldBuildTime := Version, BuildTime
	Version, BuildTime = "26.11.103", "2026-11-01T08:00:00Z"
	t.Cleanup(func() { Version, BuildTime = oldVersion, oldBuildTime })
	ts, key := newTestServer(t)
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/system/health", nil)
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
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var body struct {
		Success bool `json:"success"`
		Data    struct {
			Status    string `json:"status"`
			Version   string `json:"version"`
			BuildTime string `json:"buildTime"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.Success {
		t.Fatal("health response must set success=true for the frontend access-key probe")
	}
	if body.Data.Status != "ok" || body.Data.Version != Version || body.Data.BuildTime != BuildTime {
		t.Fatalf("health data = %+v", body.Data)
	}
}
