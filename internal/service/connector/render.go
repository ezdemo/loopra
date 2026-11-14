package connector

import (
	"fmt"
	"net/url"
	"strings"
)

// Spec 是占位符替换后的传输描述，只用于构建 MCP 传输，
// 其中可能含令牌等敏感值，不进入任何 API 响应或日志。
type Spec struct {
	Name    string // 连接器 id
	Type    string // stdio | sse | streamable
	URL     string
	Command string
	Args    []string
	Env     map[string]string
	Headers map[string]string
}

// Render 用已存储的字段值实例化连接器传输模板；缺失字段返回错误。
func Render(conn Connector, fields map[string]string) (Spec, error) {
	substitute := func(text string, escape func(string) string) (string, error) {
		var missing string
		out := placeholderPattern.ReplaceAllStringFunc(text, func(token string) string {
			key := token[2 : len(token)-2]
			value, ok := fields[key]
			if !ok || value == "" {
				missing = key
				return token
			}
			if escape != nil {
				return escape(value)
			}
			return value
		})
		if missing != "" {
			return "", fmt.Errorf("连接器 %s 缺少必填字段 %q", conn.ID, missing)
		}
		return out, nil
	}
	raw := func(text string) (string, error) { return substitute(text, nil) }
	queryEscaped := func(text string) (string, error) { return substitute(text, url.QueryEscape) }

	spec := Spec{Name: conn.ID, Type: conn.Transport.Type}
	var err error
	// URL 里的占位符按查询参数值转义（目录中它们都出现在 ?key= 等位置）。
	if spec.URL, err = queryEscaped(conn.Transport.URL); err != nil {
		return Spec{}, err
	}
	if spec.Command, err = raw(conn.Transport.Command); err != nil {
		return Spec{}, err
	}
	for _, arg := range conn.Transport.Args {
		value, err := raw(arg)
		if err != nil {
			return Spec{}, err
		}
		spec.Args = append(spec.Args, value)
	}
	if len(conn.Transport.Env) > 0 {
		spec.Env = map[string]string{}
		for key, value := range conn.Transport.Env {
			k, err := raw(key)
			if err != nil {
				return Spec{}, err
			}
			v, err := raw(value)
			if err != nil {
				return Spec{}, err
			}
			spec.Env[k] = v
		}
	}
	if len(conn.Transport.Headers) > 0 {
		spec.Headers = map[string]string{}
		for key, value := range conn.Transport.Headers {
			k, err := raw(key)
			if err != nil {
				return Spec{}, err
			}
			v, err := raw(value)
			if err != nil {
				return Spec{}, err
			}
			spec.Headers[k] = v
		}
	}
	return spec, nil
}

// requiredFieldKeys 返回连接时必须非空的字段 key。
func requiredFieldKeys(conn Connector) []string {
	keys := make([]string, 0, len(conn.Auth.Fields))
	for _, field := range conn.Auth.Fields {
		keys = append(keys, field.Key)
	}
	return keys
}

// validateFields 检查必填字段齐全，返回去掉空白后的副本。
func validateFields(conn Connector, fields map[string]string) (map[string]string, error) {
	clean := map[string]string{}
	for key, value := range fields {
		if strings.TrimSpace(value) != "" {
			clean[key] = value
		}
	}
	for _, key := range requiredFieldKeys(conn) {
		if clean[key] == "" {
			return nil, fmt.Errorf("连接器 %s 缺少必填字段 %q", conn.ID, key)
		}
	}
	return clean, nil
}
