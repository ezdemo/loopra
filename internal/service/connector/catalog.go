// Package connector 把内置服务目录（飞书、Notion、GitHub 等）包装成
// 面向非开发者的连接器：OAuth 一键授权或粘贴凭据即可把服务的
// MCP 工具接入会话。已连接的连接器在工具管线里以同名 MCP
// 服务出现。
package connector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"regexp"
	"sort"
	"strings"

	connectordata "github.com/ezdemo/looprax/connectors"
)

// Catalog 是 catalog.json 的结构：分类、来源、展示顺序 + 连接器
// 模板。模板里的 {{fieldKey}} 占位符在连接时由用户提交的字段值替换。
type Catalog struct {
	Version    int         `json:"version"`
	Categories []Category  `json:"categories"`
	Sources    []Source    `json:"sources,omitempty"`
	Order      []string    `json:"order,omitempty"`
	Connectors []Connector `json:"connectors,omitempty"`
}

// Category 是连接器分组。
type Category struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

type SourceRef struct {
	ID    string `json:"id"`
	Entry string `json:"entry"`
	URL   string `json:"url"`
}

// Connector 描述一个内置服务的接入方式。
type Connector struct {
	SchemaVersion int    `json:"schemaVersion,omitempty"`
	Kind          string `json:"kind,omitempty"`
	ID            string `json:"id"`
	Name          string `json:"name"`
	Category      string `json:"category"`
	Color         string `json:"color,omitempty"`
	// Icon 是前端图标键（与 web/src/assets/connectors 资源或内置
	// 图标集对应），为空时前端回退到首字母占位。
	Icon         string      `json:"icon,omitempty"`
	Description  string      `json:"description"`
	Capabilities []string    `json:"capabilities,omitempty"`
	DocsURL      string      `json:"docsUrl,omitempty"`
	Methods      []string    `json:"methods,omitempty"`
	Requires     []string    `json:"requires,omitempty"`
	Transport    Transport   `json:"transport"`
	Auth         Auth        `json:"auth"`
	Sources      []SourceRef `json:"sources,omitempty"`
	Repository   string      `json:"repository,omitempty"`
	License      string      `json:"license,omitempty"`
	Tags         []string    `json:"tags,omitempty"`
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
	Type   string `json:"type"` // oauth | token | credentials | none
	Client string `json:"client,omitempty"`
	// Client == "user" 表示用户需要在目标平台预先注册 OAuth
	// 客户端并提交 clientId/clientSecret；为空表示走动态客户端注册。
	HelpURL       string   `json:"helpUrl,omitempty"`
	Fields        []Field  `json:"fields,omitempty"`
	ExcludeScopes []string `json:"excludeScopes,omitempty"`
}

// Field 是用户在连接表单里填写的字段。
type Field struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Secret      bool   `json:"secret,omitempty"`
	Optional    bool   `json:"optional,omitempty"`
	Default     string `json:"default,omitempty"`
	Type        string `json:"type,omitempty"` // text | url | path
	Placeholder string `json:"placeholder,omitempty"`
	HelpURL     string `json:"helpUrl,omitempty"`
}

func (f Field) IsOptional() bool { return f.Optional || f.Default != "" }

var placeholderPattern = regexp.MustCompile(`\{\{([a-zA-Z0-9_]+)\}\}`)

var connectorIDPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var fieldKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)
var headerNamePattern = regexp.MustCompile(`^[!#$%&'*+\-.^_` + "`" + `|~0-9A-Za-z]+$`)

var knownMethods = map[string]bool{"mcp": true, "skill": true, "cli": true}
var knownRequires = map[string]bool{"node": true, "uv": true, "python": true, "docker": true}
var knownFieldTypes = map[string]bool{"": true, "text": true, "url": true, "path": true}

// LoadCatalog 读取并校验嵌入的内置仓库。
func LoadCatalog() (Catalog, error) {
	return LoadCatalogFS(connectordata.FS)
}

type catalogFile struct {
	Version    int        `json:"version"`
	Categories []Category `json:"categories"`
	Sources    []Source   `json:"sources"`
	Order      []string   `json:"order"`
}

func decodeStrict(data []byte, name string, out any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("parse %s: %w", name, err)
	}
	var extra any
	err := dec.Decode(&extra)
	if err != io.EOF {
		if err == nil {
			return fmt.Errorf("parse %s: trailing content", name)
		}
		return fmt.Errorf("parse %s: trailing content: %w", name, err)
	}
	return nil
}

func LoadCatalogFS(fsys fs.FS) (Catalog, error) {
	data, err := fs.ReadFile(fsys, "catalog.json")
	if err != nil {
		return Catalog{}, fmt.Errorf("read connector catalog: %w", err)
	}
	var head catalogFile
	if err := decodeStrict(data, "connector catalog", &head); err != nil {
		return Catalog{}, err
	}
	if head.Version != 1 {
		return Catalog{}, fmt.Errorf("connector catalog: unsupported version %d", head.Version)
	}
	catalog := Catalog{
		Version:    head.Version,
		Categories: head.Categories,
		Sources:    head.Sources,
		Order:      head.Order,
	}
	entries, err := fs.Glob(fsys, "registry/*.json")
	if err != nil {
		return Catalog{}, fmt.Errorf("read connector registry: %w", err)
	}
	if len(entries) == 0 {
		return Catalog{}, fmt.Errorf("connector catalog: empty registry")
	}
	sort.Strings(entries)
	byID := map[string]Connector{}
	for _, path := range entries {
		data, err := fs.ReadFile(fsys, path)
		if err != nil {
			return Catalog{}, fmt.Errorf("read %s: %w", path, err)
		}
		var conn Connector
		if err := decodeStrict(data, path, &conn); err != nil {
			return Catalog{}, err
		}
		want := strings.TrimPrefix(strings.TrimSuffix(path, ".json"), "registry/")
		if conn.ID != want {
			return Catalog{}, fmt.Errorf("%s: connector id %q does not match file name", path, conn.ID)
		}
		if conn.SchemaVersion != 1 {
			return Catalog{}, fmt.Errorf("connector %s: unsupported schemaVersion %d", conn.ID, conn.SchemaVersion)
		}
		if conn.Kind != "mcp" {
			return Catalog{}, fmt.Errorf("connector %s: unsupported kind %q", conn.ID, conn.Kind)
		}
		if _, dup := byID[conn.ID]; dup {
			return Catalog{}, fmt.Errorf("connector catalog: duplicate connector id %q", conn.ID)
		}
		byID[conn.ID] = conn
	}
	if len(head.Order) == 0 {
		return Catalog{}, fmt.Errorf("connector catalog: empty order")
	}
	seen := map[string]bool{}
	for _, id := range head.Order {
		if seen[id] {
			return Catalog{}, fmt.Errorf("connector catalog: duplicate order id %q", id)
		}
		seen[id] = true
		conn, ok := byID[id]
		if !ok {
			return Catalog{}, fmt.Errorf("connector catalog: order id %q has no descriptor", id)
		}
		catalog.Connectors = append(catalog.Connectors, conn)
	}
	if len(catalog.Connectors) != len(byID) {
		return Catalog{}, fmt.Errorf("connector catalog: order does not cover all descriptors")
	}
	if err := catalog.Validate(); err != nil {
		return Catalog{}, err
	}
	if err := catalog.validateRepoMeta(); err != nil {
		return Catalog{}, err
	}
	for _, conn := range catalog.Connectors {
		if err := catalog.validateRepo(conn); err != nil {
			return Catalog{}, err
		}
	}
	return catalog, nil
}

// Validate 校验目录结构：id 唯一、分类已知、所有占位符都有对应
// 字段声明、授权方式声明完整。
func (c Catalog) Validate() error {
	categories := map[string]bool{}
	for _, category := range c.Categories {
		if category.ID == "" || categories[category.ID] {
			return fmt.Errorf("connector catalog: invalid category id %q", category.ID)
		}
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
	if c.Kind != "" && c.Kind != "mcp" {
		return fmt.Errorf("connector %s: unsupported kind %q", c.ID, c.Kind)
	}
	fields := map[string]Field{}
	for _, field := range c.Auth.Fields {
		if field.Key == "" {
			return fmt.Errorf("connector %s: empty field key", c.ID)
		}
		if !fieldKeyPattern.MatchString(field.Key) {
			return fmt.Errorf("connector %s: invalid field key %q", c.ID, field.Key)
		}
		if _, dup := fields[field.Key]; dup {
			return fmt.Errorf("connector %s: duplicate field key %q", c.ID, field.Key)
		}
		if !knownFieldTypes[field.Type] {
			return fmt.Errorf("connector %s: unknown field type %q", c.ID, field.Type)
		}
		if field.Default != "" && field.Secret {
			return fmt.Errorf("connector %s: field %q default must not be secret", c.ID, field.Key)
		}
		if field.Default != "" && !field.Optional {
			return fmt.Errorf("connector %s: field %q is required and cannot declare a default", c.ID, field.Key)
		}
		if field.Default != "" {
			if err := validateFieldValue(field, field.Default); err != nil {
				return fmt.Errorf("connector %s: field %q default: %w", c.ID, field.Key, err)
			}
		}
		if err := checkHTTPSURLOptional(field.HelpURL); err != nil {
			return fmt.Errorf("connector %s: field %q helpUrl: %w", c.ID, field.Key, err)
		}
		fields[field.Key] = field
	}
	switch c.Auth.Type {
	case "oauth":
		if c.Transport.Type != "streamable" {
			return fmt.Errorf("connector %s: oauth requires streamable transport", c.ID)
		}
		if c.Auth.Client != "" && c.Auth.Client != "user" {
			return fmt.Errorf("connector %s: unknown oauth client %q", c.ID, c.Auth.Client)
		}
		if c.Auth.Client == "user" {
			clientID, ok := fields["clientId"]
			if !ok || clientID.IsOptional() {
				return fmt.Errorf("connector %s: oauth with user client requires required clientId field", c.ID)
			}
			secret, ok := fields["clientSecret"]
			if !ok || secret.IsOptional() || !secret.Secret {
				return fmt.Errorf("connector %s: oauth with user client requires required secret clientSecret field", c.ID)
			}
		}
	case "token", "credentials":
		if len(c.Auth.Fields) == 0 {
			return fmt.Errorf("connector %s: auth %q requires at least one field", c.ID, c.Auth.Type)
		}
		if c.Auth.Client != "" || len(c.Auth.ExcludeScopes) > 0 {
			return fmt.Errorf("connector %s: client/excludeScopes only apply to oauth", c.ID)
		}
	case "none":
		for _, field := range c.Auth.Fields {
			if field.Secret {
				return fmt.Errorf("connector %s: auth none must not declare secret field %q", c.ID, field.Key)
			}
		}
		if c.Auth.Client != "" || len(c.Auth.ExcludeScopes) > 0 {
			return fmt.Errorf("connector %s: client/excludeScopes only apply to oauth", c.ID)
		}
	default:
		return fmt.Errorf("connector %s: unknown auth type %q", c.ID, c.Auth.Type)
	}
	if err := checkHTTPSURLOptional(c.Auth.HelpURL); err != nil {
		return fmt.Errorf("connector %s: helpUrl: %w", c.ID, err)
	}
	requiresSeen := map[string]bool{}
	for _, req := range c.Requires {
		if !knownRequires[req] {
			return fmt.Errorf("connector %s: unknown requirement %q", c.ID, req)
		}
		if requiresSeen[req] {
			return fmt.Errorf("connector %s: duplicate requirement %q", c.ID, req)
		}
		requiresSeen[req] = true
	}
	for _, placeholder := range c.placeholders() {
		if _, ok := fields[placeholder]; !ok {
			return fmt.Errorf("connector %s: placeholder {{%s}} has no matching auth field", c.ID, placeholder)
		}
	}
	if placeholderPattern.MatchString(c.Transport.Command) {
		return fmt.Errorf("connector %s: command must not contain placeholders", c.ID)
	}
	if strings.ContainsRune(c.Transport.Command, '\x00') {
		return fmt.Errorf("connector %s: command must not contain NUL", c.ID)
	}
	if err := checkNoBraces(c.ID, "command", c.Transport.Command); err != nil {
		return err
	}
	for key := range c.Transport.Env {
		if key == "" || strings.ContainsAny(key, "=\x00\r\n") || strings.ContainsAny(key, "{}") {
			return fmt.Errorf("connector %s: invalid env key %q", c.ID, key)
		}
	}
	for key := range c.Transport.Headers {
		if !headerNamePattern.MatchString(key) {
			return fmt.Errorf("connector %s: invalid header name %q", c.ID, key)
		}
	}
	for _, arg := range c.Transport.Args {
		if err := c.checkOptionalWhole(arg, fields); err != nil {
			return err
		}
		if strings.ContainsRune(arg, '\x00') {
			return fmt.Errorf("connector %s: arg must not contain NUL", c.ID)
		}
		if err := checkNoBraces(c.ID, "arg", arg); err != nil {
			return err
		}
	}
	for _, value := range c.Transport.Env {
		if err := c.checkOptionalWhole(value, fields); err != nil {
			return err
		}
		if strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("connector %s: env value must not contain NUL or CRLF", c.ID)
		}
		if err := checkNoBraces(c.ID, "env value", value); err != nil {
			return err
		}
	}
	for key, value := range c.Transport.Headers {
		if err := c.checkOptionalWhole(value, fields); err != nil {
			return err
		}
		if strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("connector %s: header %q must not contain NUL or CRLF", c.ID, key)
		}
		if err := checkNoBraces(c.ID, "header "+key, value); err != nil {
			return err
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
		if err := c.checkURLTemplate(fields); err != nil {
			return err
		}
	default:
		return fmt.Errorf("connector %s: unknown transport type %q", c.ID, c.Transport.Type)
	}
	return nil
}

func checkNoBraces(id, what, text string) error {
	clean := placeholderPattern.ReplaceAllString(text, "")
	if strings.ContainsAny(clean, "{}") {
		return fmt.Errorf("connector %s: malformed placeholder in %s", id, what)
	}
	return nil
}

func (c Connector) checkOptionalWhole(text string, fields map[string]Field) error {
	for _, match := range placeholderPattern.FindAllStringSubmatch(text, -1) {
		field, ok := fields[match[1]]
		if !ok {
			continue
		}
		if field.IsOptional() && field.Default == "" && text != "{{"+field.Key+"}}" {
			return fmt.Errorf("connector %s: optional field {{%s}} must be the whole template value", c.ID, field.Key)
		}
	}
	return nil
}

func (c Connector) checkURLTemplate(fields map[string]Field) error {
	raw := c.Transport.URL
	if strings.ContainsAny(raw, "\r\n") {
		return fmt.Errorf("connector %s: url template must not contain CRLF", c.ID)
	}
	if key, ok := wholePlaceholder(raw); ok {
		field, declared := fields[key]
		if !declared {
			return fmt.Errorf("connector %s: placeholder {{%s}} has no matching auth field", c.ID, key)
		}
		if field.IsOptional() || field.Type != "url" {
			return fmt.Errorf("connector %s: whole-url placeholder {{%s}} requires a required url-typed field", c.ID, key)
		}
		return nil
	}
	if err := checkNoBraces(c.ID, "url", raw); err != nil {
		return err
	}
	static := placeholderPattern.ReplaceAllString(raw, "x")
	parsed, err := url.Parse(static)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" || parsed.Opaque != "" {
		return fmt.Errorf("connector %s: invalid url template", c.ID)
	}
	if parsed.User != nil {
		return fmt.Errorf("connector %s: url template must not contain userinfo", c.ID)
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("connector %s: url template must not contain fragment", c.ID)
	}
	beforeQuery, query, _ := strings.Cut(raw, "?")
	if strings.ContainsAny(beforeQuery, "{}") || placeholderPattern.MatchString(beforeQuery) {
		return fmt.Errorf("connector %s: url placeholders must appear in query values", c.ID)
	}
	for _, pair := range strings.Split(query, "&") {
		key, _, _ := strings.Cut(pair, "=")
		if strings.Contains(key, "{{") {
			return fmt.Errorf("connector %s: url placeholders must appear in query values", c.ID)
		}
	}
	for _, match := range placeholderPattern.FindAllStringSubmatch(raw, -1) {
		field, ok := fields[match[1]]
		if !ok {
			continue
		}
		if field.IsOptional() && field.Default == "" {
			return fmt.Errorf("connector %s: optional field {{%s}} in url query requires a default", c.ID, field.Key)
		}
	}
	return nil
}

func wholePlaceholder(text string) (string, bool) {
	if match := placeholderPattern.FindStringSubmatch(text); match != nil && match[0] == text {
		return match[1], true
	}
	return "", false
}

func checkHTTPSURL(raw string) error {
	if strings.ContainsAny(raw, "\r\n") {
		return fmt.Errorf("url must not contain CRLF")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" || parsed.Opaque != "" {
		return fmt.Errorf("url must be a valid http(s) address")
	}
	if parsed.User != nil {
		return fmt.Errorf("url must not contain userinfo")
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("url must not contain fragment")
	}
	return nil
}

func checkHTTPSURLOptional(raw string) error {
	if raw == "" {
		return nil
	}
	return checkHTTPSURL(raw)
}

func (c Catalog) validateRepoMeta() error {
	categories := map[string]bool{}
	for _, category := range c.Categories {
		if !connectorIDPattern.MatchString(category.ID) || categories[category.ID] {
			return fmt.Errorf("connector catalog: invalid category id %q", category.ID)
		}
		if strings.TrimSpace(category.Name) == "" {
			return fmt.Errorf("connector catalog: category %s empty name", category.ID)
		}
		categories[category.ID] = true
	}
	sources := map[string]bool{}
	for _, source := range c.Sources {
		if !connectorIDPattern.MatchString(source.ID) || sources[source.ID] {
			return fmt.Errorf("connector catalog: invalid source id %q", source.ID)
		}
		if strings.TrimSpace(source.Name) == "" {
			return fmt.Errorf("connector catalog: source %s empty name", source.ID)
		}
		if err := checkHTTPSURL(source.URL); err != nil {
			return fmt.Errorf("connector catalog: source %s url: %w", source.ID, err)
		}
		sources[source.ID] = true
	}
	return nil
}

func (c Catalog) validateRepo(conn Connector) error {
	sources := map[string]bool{}
	for _, source := range c.Sources {
		sources[source.ID] = true
	}
	if !connectorIDPattern.MatchString(conn.ID) {
		return fmt.Errorf("connector %s: id must be lowercase kebab-case", conn.ID)
	}
	if strings.TrimSpace(conn.Name) == "" {
		return fmt.Errorf("connector %s: empty name", conn.ID)
	}
	if strings.TrimSpace(conn.Description) == "" {
		return fmt.Errorf("connector %s: empty description", conn.ID)
	}
	if len(conn.Methods) == 0 {
		return fmt.Errorf("connector %s: empty methods", conn.ID)
	}
	seen := map[string]bool{}
	for _, method := range conn.Methods {
		if !knownMethods[method] {
			return fmt.Errorf("connector %s: unknown method %q", conn.ID, method)
		}
		if seen[method] {
			return fmt.Errorf("connector %s: duplicate method %q", conn.ID, method)
		}
		seen[method] = true
	}
	if !seen["mcp"] {
		return fmt.Errorf("connector %s: connector must declare mcp method", conn.ID)
	}
	if conn.Sources == nil {
		return fmt.Errorf("connector %s: missing sources", conn.ID)
	}
	switch conn.Transport.Type {
	case "stdio":
		if conn.Transport.URL != "" || len(conn.Transport.Headers) > 0 {
			return fmt.Errorf("connector %s: stdio transport must not declare url/headers", conn.ID)
		}
	case "sse", "streamable":
		if conn.Transport.Command != "" || len(conn.Transport.Args) > 0 || len(conn.Transport.Env) > 0 {
			return fmt.Errorf("connector %s: %s transport must not declare command/args/env", conn.ID, conn.Transport.Type)
		}
	}
	if conn.Auth.Type == "" {
		return fmt.Errorf("connector %s: connector requires auth", conn.ID)
	}
	if err := checkHTTPSURLOptional(conn.Repository); err != nil {
		return fmt.Errorf("connector %s: repository: %w", conn.ID, err)
	}
	if err := checkHTTPSURLOptional(conn.DocsURL); err != nil {
		return fmt.Errorf("connector %s: docsUrl: %w", conn.ID, err)
	}
	refSeen := map[string]bool{}
	for _, ref := range conn.Sources {
		if !sources[ref.ID] {
			return fmt.Errorf("connector %s: unknown source %q", conn.ID, ref.ID)
		}
		if refSeen[ref.ID] {
			return fmt.Errorf("connector %s: duplicate source ref %q", conn.ID, ref.ID)
		}
		refSeen[ref.ID] = true
		if strings.TrimSpace(ref.Entry) == "" {
			return fmt.Errorf("connector %s: source %q empty entry", conn.ID, ref.ID)
		}
		if err := checkHTTPSURL(ref.URL); err != nil {
			return fmt.Errorf("connector %s: source %q url: %w", conn.ID, ref.ID, err)
		}
	}
	for _, field := range conn.Auth.Fields {
		if strings.TrimSpace(field.Label) == "" {
			return fmt.Errorf("connector %s: field %q empty label", conn.ID, field.Key)
		}
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
