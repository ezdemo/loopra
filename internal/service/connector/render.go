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
	clean, err := validateFields(conn, fields)
	if err != nil {
		return Spec{}, err
	}
	declared := map[string]Field{}
	for _, field := range conn.Auth.Fields {
		declared[field.Key] = field
	}
	substitute := func(text string, escape func(string) string) (string, error) {
		var missing string
		out := placeholderPattern.ReplaceAllStringFunc(text, func(token string) string {
			key := token[2 : len(token)-2]
			value := clean[key]
			if value == "" {
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
	whole := func(text string) (string, bool, error) {
		key, ok := wholePlaceholder(text)
		if !ok {
			value, err := substitute(text, nil)
			return value, true, err
		}
		field, declared := declared[key]
		value := clean[key]
		if value == "" {
			if declared && field.IsOptional() {
				return "", false, nil
			}
			return "", false, fmt.Errorf("连接器 %s 缺少必填字段 %q", conn.ID, key)
		}
		return value, true, nil
	}

	spec := Spec{Name: conn.ID, Type: conn.Transport.Type}
	// URL 里的占位符按查询参数值转义（目录中它们都出现在 ?key= 等位置）。
	if key, ok := wholePlaceholder(conn.Transport.URL); ok {
		value := clean[key]
		if value == "" {
			return Spec{}, fmt.Errorf("连接器 %s 缺少必填字段 %q", conn.ID, key)
		}
		if err := checkHTTPSURL(value); err != nil {
			return Spec{}, fmt.Errorf("连接器 %s 字段 %q: %w", conn.ID, key, err)
		}
		spec.URL = value
	} else if spec.URL, err = substitute(conn.Transport.URL, url.QueryEscape); err != nil {
		return Spec{}, err
	}
	if spec.Command, err = substitute(conn.Transport.Command, nil); err != nil {
		return Spec{}, err
	}
	for _, arg := range conn.Transport.Args {
		value, keep, err := whole(arg)
		if err != nil {
			return Spec{}, err
		}
		if keep {
			spec.Args = append(spec.Args, value)
		}
	}
	if len(conn.Transport.Env) > 0 {
		spec.Env = map[string]string{}
		for key, value := range conn.Transport.Env {
			v, keep, err := whole(value)
			if err != nil {
				return Spec{}, err
			}
			if keep {
				spec.Env[key] = v
			}
		}
	}
	if len(conn.Transport.Headers) > 0 {
		spec.Headers = map[string]string{}
		for key, value := range conn.Transport.Headers {
			v, keep, err := whole(value)
			if err != nil {
				return Spec{}, err
			}
			if keep {
				spec.Headers[key] = v
			}
		}
	}
	return spec, nil
}

// requiredFieldKeys 返回连接时必须非空的字段 key。
func requiredFieldKeys(conn Connector) []string {
	keys := make([]string, 0, len(conn.Auth.Fields))
	for _, field := range conn.Auth.Fields {
		if !field.IsOptional() {
			keys = append(keys, field.Key)
		}
	}
	return keys
}

// validateFields 归一化用户提交或已存的字段：拒绝未声明字段、
// 应用默认值、校验类型与 CRLF，要求必填字段非空。
func validateFields(conn Connector, fields map[string]string) (map[string]string, error) {
	declared := map[string]Field{}
	for _, field := range conn.Auth.Fields {
		declared[field.Key] = field
	}
	clean := map[string]string{}
	for key, value := range fields {
		field, ok := declared[key]
		if !ok {
			return nil, fmt.Errorf("连接器 %s 存在未知字段 %q", conn.ID, key)
		}
		if strings.TrimSpace(value) == "" {
			continue
		}
		if err := validateFieldValue(field, value); err != nil {
			return nil, fmt.Errorf("连接器 %s %w", conn.ID, err)
		}
		clean[key] = value
	}
	for _, field := range conn.Auth.Fields {
		if clean[field.Key] == "" && field.Default != "" {
			if err := validateFieldValue(field, field.Default); err != nil {
				return nil, fmt.Errorf("连接器 %s %w", conn.ID, err)
			}
			clean[field.Key] = field.Default
		}
	}
	for _, key := range requiredFieldKeys(conn) {
		if clean[key] == "" {
			return nil, fmt.Errorf("连接器 %s 缺少必填字段 %q", conn.ID, key)
		}
	}
	return clean, nil
}

func validateFieldValue(field Field, value string) error {
	if strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("字段 %q 不能包含换行或 NUL", field.Key)
	}
	if field.Type == "url" {
		if err := checkHTTPSURL(value); err != nil {
			return fmt.Errorf("字段 %q: %w", field.Key, err)
		}
	}
	return nil
}
