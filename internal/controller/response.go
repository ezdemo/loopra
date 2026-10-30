// Package controller 在 agent 运行时之上提供与 Loopra 1:1 对齐的 HTTP API
// 接口（docs/API_CONTRACT.md、docs/SSE_AND_STORAGE_CONTRACT.md）。
package controller

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/plugin"
)

// apiResponse 对应 Java 的 ApiResponse 包装：null 字段被省略。
type apiResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Data    any    `json:"data,omitempty"`
}

func writeOK(w http.ResponseWriter, status int, data any) {
	// omitempty 会丢弃空数组；Java 显式返回 "data": []。
	// nil 切片也必须归一化，否则 json 会输出 null。
	if isEmptyCollection(data) {
		writeJSON(w, status, map[string]any{"success": true, "data": normalizeEmpty(data)})
		return
	}
	writeJSON(w, status, apiResponse{Success: true, Data: data})
}

// isEmptyCollection 判断长度为零的切片、数组或映射。
func isEmptyCollection(v any) bool {
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		return rv.Len() == 0
	default:
		return false
	}
}

// normalizeEmpty 把 nil 集合重建为空集合，使 JSON 输出
// [] / {} 而不是 null。
func normalizeEmpty(v any) any {
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice:
		return reflect.MakeSlice(rv.Type(), 0, 0).Interface()
	case reflect.Map:
		return reflect.MakeMap(rv.Type()).Interface()
	default:
		return v
	}
}

func writeFail(w http.ResponseWriter, status int, message string) {
	logging.Debugf("api", "%d %s", status, message)
	writeJSON(w, status, apiResponse{Success: false, Error: message})
}

// writeErr 把领域错误写成 API 失败。带 HTTPStatus 的错误保留约定的状态码。
func writeErr(w http.ResponseWriter, err error) {
	type httpStatus interface {
		error
		HTTPStatus() int
	}
	var status httpStatus
	if errors.As(err, &status) {
		writeFail(w, status.HTTPStatus(), status.Error())
		return
	}
	writeFail(w, http.StatusInternalServerError, err.Error())
}

func writeFailReason(w http.ResponseWriter, status int, message, reason string) {
	writeJSON(w, status, apiResponse{Success: false, Error: message, Reason: reason})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json;charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// AccessKey 用 X-Loopra-Key 守卫所有 /api 路由，采用常量时间比较。
type AccessKey struct {
	value string
}

// NewAccessKey 生成 32 字节随机密钥，Base64url 无填充。
func NewAccessKey() (AccessKey, string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return AccessKey{}, "", err
	}
	value := base64.RawURLEncoding.EncodeToString(buf)
	return AccessKey{value: value}, value, nil
}

// ParseAccessKey 用已有值构造守卫（环境变量覆盖）。
func ParseAccessKey(value string) AccessKey { return AccessKey{value: value} }

// Match 以常量时间比较传入的密钥。
func (k AccessKey) Match(presented string) bool {
	return subtle.ConstantTimeCompare([]byte(k.value), []byte(presented)) == 1
}

// auth 用 Loopra 访问规则包装处理器：所有请求都校验
// X-Loopra-Key 头，但 pets spritesheet 路径可用 ?rk=。
// 插件设置页的 iframe 不能带这个头，只接受它自己的 HttpOnly cookie。
func (k AccessKey) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		path := r.URL.Path
		if strings.HasPrefix(path, "/api") || path == "/api" {
			w.Header().Set("Cache-Control", "no-store")
			presented := r.Header.Get("X-Loopra-Key")
			if presented == "" && r.Method == http.MethodGet &&
				strings.HasPrefix(path, "/api/pets/") && strings.HasSuffix(path, "/spritesheet") {
				presented = r.URL.Query().Get("rk")
			}
			if presented == "" && plugin.ValidUIRequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			if !k.Match(presented) {
				w.Header().Set("Cache-Control", "no-store")
				writeFailReason(w, http.StatusUnauthorized,
					"访问密钥缺失或错误，请输入启动日志中的 rk 密钥", "access_key_required")
				return
			}
		} else if r.Method != http.MethodGet && r.Method != http.MethodHead {
			// 对静态路径的非 API 变更请求不属于该接口面。
			w.Header().Set("Cache-Control", "no-store")
		}
		if !(strings.HasPrefix(path, "/api") || path == "/api") {
			// 静态资源可缓存；动态路径一律不缓存。
			if !hasStaticAsset(path) {
				w.Header().Set("Cache-Control", "no-store")
			}
		}
		next.ServeHTTP(w, r)
	})
}

// hasStaticAsset 判断前端资源路径是否可缓存（在 embed 清单
// 落地前按扩展名判断；HTML 永不缓存）。
func hasStaticAsset(path string) bool {
	switch {
	case strings.HasSuffix(path, ".html"):
		return false
	case strings.Contains(path, "."):
		return staticAssetExt(path)
	default:
		return false
	}
}

func staticAssetExt(path string) bool {
	for _, ext := range []string{
		".js", ".mjs", ".css", ".map", ".json", ".png", ".jpg", ".jpeg",
		".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot",
		".wasm", ".txt",
	} {
		if strings.HasSuffix(path, ext) {
			return true
		}
	}
	return false
}
