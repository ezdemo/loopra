package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	internalmodel "github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/model/config"
)

type fakeConfigService struct {
	value   *config.Loopra
	updates int
}

func (f *fakeConfigService) Snapshot() *config.Loopra { return f.value.Clone() }

func (f *fakeConfigService) Update(patch map[string]any) (*config.Loopra, error) {
	f.updates++
	return f.value.Clone(), nil
}

type fakeFileService struct {
	root, relative string
}

func (f *fakeFileService) Tree(root, relative string) ([]internalmodel.FileEntry, error) {
	f.root, f.relative = root, relative
	return []internalmodel.FileEntry{{Name: "README.md", Path: "README.md"}}, nil
}

func (*fakeFileService) Search(string, string) []internalmodel.FileEntry { return nil }
func (*fakeFileService) Delete(string, string) error                     { return nil }
func (*fakeFileService) Image(string, string) ([]byte, string, error)    { return nil, "", nil }

// TestInjectedApplicationPorts keeps HTTP adapters dependent on contracts,
// matching the composition style used by Spring controllers and services.
func TestInjectedApplicationPorts(t *testing.T) {
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", "")
	workspace := t.TempDir()
	configuration := &fakeConfigService{value: &config.Loopra{WorkspaceDir: workspace}}
	files := &fakeFileService{}
	api, key, err := New(nil, Options{
		Home: t.TempDir(), AccessKey: "fixture-key",
		Configuration: configuration, Files: files,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()

	server := httptest.NewServer(NewRouter(api))
	defer server.Close()
	request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/files/tree?path=subdir", nil)
	request.Header.Set("X-Loopra-Key", key)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Success bool `json:"success"`
		Data    []struct {
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !body.Success || len(body.Data) != 1 || body.Data[0].Name != "README.md" {
		t.Fatalf("response = %+v", body)
	}
	if files.root != workspace || files.relative != "subdir" {
		t.Fatalf("file port called with root=%q relative=%q", files.root, files.relative)
	}
}
