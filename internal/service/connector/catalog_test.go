package connector

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestBuiltinCatalogLoadsAndValidates(t *testing.T) {
	catalog, err := LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Connectors) == 0 || len(catalog.Categories) == 0 {
		t.Fatal("empty catalog")
	}
	if _, ok := catalog.Find("github"); !ok {
		t.Fatal("github connector missing")
	}
}

func TestValidateRejectsUndeclaredPlaceholder(t *testing.T) {
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "x", Category: "dev",
			Transport: Transport{Type: "streamable", URL: "https://x/mcp?key={{token}}"},
			Auth:      Auth{Type: "token", Fields: []Field{{Key: "other"}}},
		}},
	}
	err := catalog.Validate()
	if err == nil || !strings.Contains(err.Error(), "{{token}}") {
		t.Fatalf("want placeholder error, got %v", err)
	}
}

func TestValidateRejectsDuplicateID(t *testing.T) {
	conn := Connector{
		ID: "dup", Category: "dev",
		Transport: Transport{Type: "streamable", URL: "https://x/mcp"},
		Auth:      Auth{Type: "oauth"},
	}
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{conn, conn},
	}
	if err := catalog.Validate(); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("want duplicate error, got %v", err)
	}
}

func TestValidateOAuthUserClientRequiresClientFields(t *testing.T) {
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "x", Category: "dev",
			Transport: Transport{Type: "streamable", URL: "https://x/mcp"},
			Auth:      Auth{Type: "oauth", Client: "user"},
		}},
	}
	if err := catalog.Validate(); err == nil {
		t.Fatal("want error for missing clientId/clientSecret")
	}
}

func repoFS(catalog string, files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{"catalog.json": &fstest.MapFile{Data: []byte(catalog)}}
	for name, data := range files {
		fsys["registry/"+name] = &fstest.MapFile{Data: []byte(data)}
	}
	return fsys
}

const testCatalogHead = `{"version":1,"categories":[{"id":"dev","name":"开发"}],"sources":[{"id":"howai","name":"HowAI","url":"https://howai.build/x"}],"order":["x"]}`

const testConnectorFile = `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"none"},"sources":[]}`

func TestLoadCatalogFSValid(t *testing.T) {
	catalog, err := LoadCatalogFS(repoFS(testCatalogHead, map[string]string{"x.json": testConnectorFile}))
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Connectors) != 1 || catalog.Connectors[0].ID != "x" {
		t.Fatalf("catalog = %+v", catalog.Connectors)
	}
}

func TestLoadCatalogFSRejectsBadInput(t *testing.T) {
	cases := map[string]struct {
		catalog string
		files   map[string]string
	}{
		"trailing catalog":       {testCatalogHead + " {}", map[string]string{"x.json": testConnectorFile}},
		"unknown catalog key":    {strings.Replace(testCatalogHead, `"order":["x"]`, `"order":["x"],"extra":1`, 1), map[string]string{"x.json": testConnectorFile}},
		"bad catalog version":    {strings.Replace(testCatalogHead, `"version":1`, `"version":2`, 1), map[string]string{"x.json": testConnectorFile}},
		"empty order":            {strings.Replace(testCatalogHead, `"order":["x"]`, `"order":[]`, 1), map[string]string{"x.json": testConnectorFile}},
		"order misses id":        {strings.Replace(testCatalogHead, `"order":["x"]`, `"order":["x","y"]`, 1), map[string]string{"x.json": testConnectorFile}},
		"order duplicates":       {strings.Replace(testCatalogHead, `"order":["x"]`, `"order":["x","x"]`, 1), map[string]string{"x.json": testConnectorFile}},
		"order unknown id":       {strings.Replace(testCatalogHead, `"order":["x"]`, `"order":["ghost"]`, 1), map[string]string{"x.json": testConnectorFile}},
		"file name mismatch":     {testCatalogHead, map[string]string{"y.json": testConnectorFile}},
		"trailing descriptor":    {testCatalogHead, map[string]string{"x.json": testConnectorFile + " {}"}},
		"unknown descriptor key": {testCatalogHead, map[string]string{"x.json": strings.Replace(testConnectorFile, `"sources":[]`, `"sources":[],"extra":1`, 1)}},
		"bad schemaVersion":      {testCatalogHead, map[string]string{"x.json": strings.Replace(testConnectorFile, `"schemaVersion":1`, `"schemaVersion":2`, 1)}},
		"bad kind":               {testCatalogHead, map[string]string{"x.json": strings.Replace(testConnectorFile, `"kind":"mcp"`, `"kind":"bogus"`, 1)}},
		"empty registry":         {testCatalogHead, map[string]string{}},
		"malformed":              {testCatalogHead, map[string]string{"x.json": `{"id":`}},
	}
	for name, tc := range cases {
		if _, err := LoadCatalogFS(repoFS(tc.catalog, tc.files)); err == nil {
			t.Fatalf("%s: want error", name)
		}
	}
}

func TestLoadCatalogFSValidationRules(t *testing.T) {
	head := func(order string) string {
		return `{"version":1,"categories":[{"id":"dev","name":"开发"}],"sources":[{"id":"howai","name":"H","url":"https://h/x"},{"id":"dsh","name":"D","url":"https://d/y"}],"order":[` + order + `]}`
	}
	cases := map[string]struct {
		catalog string
		files   map[string]string
	}{
		"unknown source ref": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `"sources":[]`, `"sources":[{"id":"other","entry":"e","url":"https://o/x"}]`, 1)}},
		"non-http source url": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `"sources":[]`, `"sources":[{"id":"howai","entry":"e","url":"javascript:alert(1)"}]`, 1)}},
		"unknown method": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `"methods":["mcp"]`, `"methods":["bogus"]`, 1)}},
		"kind guide rejected": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `"kind":"mcp"`, `"kind":"guide"`, 1)}},
		"trailing brace": {head(`"x"`) + "}",
			map[string]string{"x.json": testConnectorFile}},
		"trailing bracket": {head(`"x"`) + "]",
			map[string]string{"x.json": testConnectorFile}},
		"second json object": {head(`"x"`) + " {}",
			map[string]string{"x.json": testConnectorFile}},
		"descriptor trailing content": {head(`"x"`),
			map[string]string{"x.json": testConnectorFile + " {}"}},
		"descriptor trailing brace": {head(`"x"`),
			map[string]string{"x.json": testConnectorFile + "}"}},
		"placeholder in url key": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp?{{key}}=v"},"auth":{"type":"token","fields":[{"key":"key","label":"K"}]},"sources":[]}`}},
		"placeholder in url host": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://{{host}}/mcp"},"auth":{"type":"token","fields":[{"key":"host","label":"H"}]},"sources":[]}`}},
		"url template fragment": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp#frag"},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"optional query placeholder": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp?key={{token}}"},"auth":{"type":"token","fields":[{"key":"token","label":"T","optional":true}]},"sources":[]}`}},
		"malformed placeholder remnant": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp?key={{bad-key}}"},"auth":{"type":"token","fields":[{"key":"bad-key","label":"B"}]},"sources":[]}`}},
		"invalid url host missing": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https:/mcp"},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"oauth on stdio": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"stdio","command":"npx"},"auth":{"type":"oauth"},"sources":[]}`}},
		"client on token auth": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"token","client":"user","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"duplicate source ref": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[{"id":"howai","entry":"X","url":"https://h/x"},{"id":"howai","entry":"X2","url":"https://h/y"}]}`}},
		"whitespace name": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":" ","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"invalid header name": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp","headers":{"Bad Header":"v"}},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"invalid category id": {`{"version":1,"categories":[{"id":"Bad Cat","name":"开发"}],"sources":[{"id":"howai","name":"H","url":"https://h/x"}],"order":["x"]}`,
			map[string]string{"x.json": testConnectorFile}},
		"bad field default": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp?region={{region}}"},"auth":{"type":"token","fields":[{"key":"region","label":"R","type":"url","optional":true,"default":"not a url"}]},"sources":[]}`}},
		"unknown requirement": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `"sources":[]`, `"requires":["rust"],"sources":[]`, 1)}},
		"unknown auth type": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `"type":"none"`, `"type":"bogus"`, 1)}},
		"field without label": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp?t={{token}}"},"auth":{"type":"token","fields":[{"key":"token"}]},"sources":[]}`}},
		"unknown field type": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"none","fields":[{"key":"p","label":"P","type":"bogus"}]},"sources":[]}`}},
		"secret default": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"none","fields":[{"key":"p","label":"P","secret":true,"optional":true,"default":"x"}]},"sources":[]}`}},
		"secret field on none": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"none","fields":[{"key":"p","label":"P","secret":true}]},"sources":[]}`}},
		"required field with default": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"none","fields":[{"key":"p","label":"P","default":"x"}]},"sources":[]}`}},
		"path placeholder in url": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/{{token}}"},"auth":{"type":"token","fields":[{"key":"token","label":"T","secret":true}]},"sources":[]}`}},
		"whole url non-url field": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"{{endpoint}}"},"auth":{"type":"token","fields":[{"key":"endpoint","label":"E","secret":true}]},"sources":[]}`}},
		"placeholder in env key": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"stdio","command":"npx","env":{"{{k}}":"v"}},"auth":{"type":"none","fields":[{"key":"k","label":"K"}]},"sources":[]}`}},
		"placeholder in command": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"stdio","command":"{{cmd}}"},"auth":{"type":"none","fields":[{"key":"cmd","label":"C"}]},"sources":[]}`}},
		"optional embedded": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp","headers":{"Authorization":"Bearer {{token}}"}},"auth":{"type":"token","fields":[{"key":"token","label":"T","secret":true,"optional":true}]},"sources":[]}`}},
		"missing sources": {head(`"x"`),
			map[string]string{"x.json": strings.Replace(testConnectorFile, `,"sources":[]`, ``, 1)}},
		"stdio with url": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"stdio","command":"npx","url":"https://x/mcp"},"auth":{"type":"none"},"sources":[]}`}},
		"streamable with env": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp","env":{"A":"b"}},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"header value crlf": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp","headers":{"X":"a
b"}},"auth":{"type":"token","fields":[{"key":"token","label":"T"}]},"sources":[]}`}},
		"env value nul": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"stdio","command":"npx","env":{"A":"a\u0000b"}},"auth":{"type":"none"},"sources":[]}`}},
		"duplicate source ids": {`{"version":1,"categories":[{"id":"dev","name":"开发"}],"sources":[{"id":"a","name":"A","url":"https://a/x"},{"id":"a","name":"B","url":"https://b/y"}],"order":["x"]}`,
			map[string]string{"x.json": testConnectorFile}},
		"duplicate field keys": {head(`"x"`),
			map[string]string{"x.json": `{"schemaVersion":1,"id":"x","name":"X","category":"dev","description":"d","kind":"mcp","methods":["mcp"],"transport":{"type":"streamable","url":"https://x/mcp"},"auth":{"type":"none","fields":[{"key":"p","label":"P"},{"key":"p","label":"Q"}]},"sources":[]}`}},
	}
	for name, tc := range cases {
		if _, err := LoadCatalogFS(repoFS(tc.catalog, tc.files)); err == nil {
			t.Fatalf("%s: want error", name)
		}
	}
}

var dshEntries = []string{
	"com.baidu/map-mcp", "com.dida365/mcp", "com.didi/mcp", "com.variflight/aviation",
	"com.amap/mcp", "cn.mcd/mcp", "com.metaso/search-mcp", "com.lkcoffee/order-mcp",
	"com.tencent/map-mcp", "com.tencent/meeting-mcp", "com.tencent/weiyun-mcp", "com.tencent/docs-mcp",
	"com.tuniu/travel", "com.yuque/mcp", "io.github.upstash/context7", "cloud.dchub/mcp-server",
	"io.github.modelcontextprotocol/fetch", "io.github.modelcontextprotocol/filesystem",
	"io.github.github/github-mcp-server", "com.mastergo/magic-mcp", "com.notion/mcp",
	"com.pixso/mcp", "io.github.microsoft/playwright-mcp", "io.github.modelcontextprotocol/sqlite",
	"cn.12306/tickets", "com.weibo/mcp", "com.tencent/weread-mcp", "com.yinxiang/mcp",
	"com.flomoapp/mcp",
}

func TestBuiltinCatalogCoversAllSourceEntries(t *testing.T) {
	catalog, err := LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	covered := map[string]map[string]bool{}
	for _, conn := range catalog.Connectors {
		for _, ref := range conn.Sources {
			if covered[ref.ID] == nil {
				covered[ref.ID] = map[string]bool{}
			}
			covered[ref.ID][ref.Entry] = true
		}
	}
	for _, name := range dshEntries {
		if !covered["dsh"][name] {
			t.Fatalf("dsh entry %q not covered by catalog", name)
		}
	}
}

func TestBuiltinCatalogPreservesOriginalConnectors(t *testing.T) {
	catalog, err := LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	originals := []string{
		"feishu", "dingtalk", "tencent-docs", "notion", "gmail", "google-calendar",
		"google-drive", "linear", "atlassian", "clickup", "monday", "airtable",
		"canva", "amap", "github", "sentry",
	}
	if len(catalog.Connectors) < len(originals) {
		t.Fatalf("catalog too small: %d", len(catalog.Connectors))
	}
	for i, id := range originals {
		if catalog.Connectors[i].ID != id {
			t.Fatalf("position %d: want %q, got %q", i, id, catalog.Connectors[i].ID)
		}
	}
	conn, _ := catalog.Find("amap")
	if conn.Transport.Type != "streamable" || conn.Transport.URL != "https://mcp.amap.com/mcp?key={{key}}" || conn.Auth.Type != "token" {
		t.Fatalf("amap changed: %+v", conn)
	}
	conn, _ = catalog.Find("github")
	if conn.Transport.Type != "streamable" || conn.Transport.URL != "https://api.githubcopilot.com/mcp/" ||
		conn.Transport.Headers["Authorization"] != "Bearer {{token}}" || conn.Auth.Type != "token" {
		t.Fatalf("github changed: %+v", conn)
	}
	conn, _ = catalog.Find("dingtalk")
	if conn.Transport.Type != "stdio" || conn.Transport.Command != "npx" ||
		len(conn.Transport.Args) != 2 || conn.Transport.Args[1] != "dingtalk-mcp@1.1.21" ||
		conn.Auth.Type != "credentials" || len(conn.Requires) != 1 || conn.Requires[0] != "node" {
		t.Fatalf("dingtalk changed: %+v", conn)
	}
	conn, _ = catalog.Find("feishu")
	if conn.Transport.Type != "streamable" || conn.Transport.URL != "https://mcp.feishu.cn/mcp" || conn.Auth.Type != "oauth" {
		t.Fatalf("feishu changed: %+v", conn)
	}
	conn, _ = catalog.Find("tencent-docs")
	if conn.Transport.Headers["Authorization"] != "{{token}}" {
		t.Fatalf("tencent-docs token header changed: %+v", conn.Transport.Headers)
	}
	for _, conn := range catalog.Connectors {
		if conn.Kind != "mcp" || conn.Transport.Type == "" || conn.Auth.Type == "" {
			t.Fatalf("connector %s is not a runnable mcp template", conn.ID)
		}
	}
}
