// Package connector 把内置服务目录（飞书、Notion、GitHub 等）包装成
// 面向非开发者的连接器：OAuth 一键授权或粘贴凭据即可把服务的
// MCP 工具接入会话。已连接的连接器在工具管线里以同名 MCP
// 服务出现。
package connector

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
)

//go:embed catalog.json
var builtinCatalogJSON []byte

// Catalog 是 catalog.json 的结构：分类 + 连接器模板。模板里的
// {{fieldKey}} 占位符在连接时由用户提交的字段值替换。
type Catalog struct {
	Version    int         `json:"version"`
	Categories []Category  `json:"categories"`
	Connectors []Connector `json:"connectors"`
}

// Category 是连接器分组。
type Category struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Connector 描述一个内置服务的接入方式。
type Connector struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Category     string    `json:"category"`
	Color        string    `json:"color,omitempty"`
	Description  string    `json:"description"`
	Capabilities []string  `json:"capabilities,omitempty"`
	DocsURL      string    `json:"docsUrl,omitempty"`
	Requires     []string  `json:"requires,omitempty"`
	Transport    Transport `json:"transport"`
	Auth         Auth      `json:"auth"`
}

// Transport 是 MCP 传输模板；URL、Args、Env、Headers 均可含
// {{fieldKey}} 占位符。
type Transport struct {
	Type    string            `json:"type"` // stdio | sse | streamable
	URL     string            `json:"url,omitempty"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// Auth 描述连接器的登录方式。
type Auth struct {
	Type   string `json:"type"` // oauth | token | credentials
	Client string `json:"client,omitempty"`
	// Client == "user" 表示用户需要在目标平台预先注册 OAuth
	// 客户端并提交 clientId/clientSecret；为空表示走动态客户端注册。
	HelpURL       string   `json:"helpUrl,omitempty"`
	Fields        []Field  `json:"fields,omitempty"`
	ExcludeScopes []string `json:"excludeScopes,omitempty"`
}

// Field 是用户在连接表单里填写的字段。
type Field struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Secret bool   `json:"secret,omitempty"`
}

var placeholderPattern = regexp.MustCompile(`\{\{([a-zA-Z0-9_]+)\}\}`)

// LoadCatalog 读取并校验内置目录。
func LoadCatalog() (Catalog, error) {
	var catalog Catalog
	if err := json.Unmarshal(builtinCatalogJSON, &catalog); err != nil {
		return Catalog{}, fmt.Errorf("parse connector catalog: %w", err)
	}
	if err := catalog.Validate(); err != nil {
		return Catalog{}, err
	}
	return catalog, nil
}

// Validate 校验目录结构：id 唯一、分类已知、所有占位符都有对应
// 字段声明、授权方式声明完整。
func (c Catalog) Validate() error {
	categories := map[string]bool{}
	for _, category := range c.Categories {
		categories[category.ID] = true
	}
	ids := map[string]bool{}
	for _, conn := range c.Connectors {
		if conn.ID == "" {
			return fmt.Errorf("connector catalog: empty connector id")
		}
		if ids[conn.ID] {
			return fmt.Errorf("connector catalog: duplicate connector id %q", conn.ID)
		}
		ids[conn.ID] = true
		if !categories[conn.Category] {
			return fmt.Errorf("connector %s: unknown category %q", conn.ID, conn.Category)
		}
		if err := conn.validate(); err != nil {
			return err
		}
	}
	return nil
}

func (c Connector) validate() error {
	fields := map[string]bool{}
	for _, field := range c.Auth.Fields {
		if field.Key == "" {
			return fmt.Errorf("connector %s: empty field key", c.ID)
		}
		fields[field.Key] = true
	}
	switch c.Auth.Type {
	case "oauth":
		if c.Auth.Client == "user" && (!fields["clientId"] || !fields["clientSecret"]) {
			return fmt.Errorf("connector %s: oauth with user client requires clientId/clientSecret fields", c.ID)
		}
	case "token", "credentials":
		if len(c.Auth.Fields) == 0 {
			return fmt.Errorf("connector %s: auth %q requires at least one field", c.ID, c.Auth.Type)
		}
	default:
		return fmt.Errorf("connector %s: unknown auth type %q", c.ID, c.Auth.Type)
	}
	for _, placeholder := range c.placeholders() {
		if !fields[placeholder] {
			return fmt.Errorf("connector %s: placeholder {{%s}} has no matching auth field", c.ID, placeholder)
		}
	}
	switch c.Transport.Type {
	case "stdio":
		if c.Transport.Command == "" {
			return fmt.Errorf("connector %s: stdio transport requires command", c.ID)
		}
	case "sse", "streamable":
		if c.Transport.URL == "" {
			return fmt.Errorf("connector %s: %s transport requires url", c.ID, c.Transport.Type)
		}
	default:
		return fmt.Errorf("connector %s: unknown transport type %q", c.ID, c.Transport.Type)
	}
	return nil
}

// placeholders 返回传输模板里出现过的全部占位符名。
func (c Connector) placeholders() []string {
	found := map[string]bool{}
	scan := func(text string) {
		for _, match := range placeholderPattern.FindAllStringSubmatch(text, -1) {
			found[match[1]] = true
		}
	}
	scan(c.Transport.URL)
	scan(c.Transport.Command)
	for _, arg := range c.Transport.Args {
		scan(arg)
	}
	for key, value := range c.Transport.Env {
		scan(key)
		scan(value)
	}
	for key, value := range c.Transport.Headers {
		scan(key)
		scan(value)
	}
	out := make([]string, 0, len(found))
	for name := range found {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Find 按 id 查找连接器。
func (c Catalog) Find(id string) (Connector, bool) {
	for _, conn := range c.Connectors {
		if conn.ID == id {
			return conn, true
		}
	}
	return Connector{}, false
}
