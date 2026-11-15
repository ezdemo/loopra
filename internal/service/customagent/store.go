// Package customagent 管理用户自定义智能体定义的持久化与校验。
// 定义保存在 <home>/agents.json，智能体 id 同时是它的工作区 hash。
package customagent

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// ErrNotFound 表示目标智能体不存在。
var ErrNotFound = errors.New("智能体不存在")

// ErrStorage 包装 agents.json 的读写与解析失败，调用方据此区分校验错误。
var ErrStorage = errors.New("智能体配置读写失败")

const (
	nameMaxRunes        = 40
	instructionMaxRunes = 20000
	reservedName        = "纯聊天"
	iconMaxBytes        = 128 << 10
	iconMaxRunes        = 32
)

var idPattern = regexp.MustCompile(`^agent_[0-9a-f]{12}$`)

// iconImagePattern 限定图标 data URL 的图片类型，覆盖 <img> 可渲染的常见格式；
// 图标经 <img> 渲染，SVG 中的脚本在该上下文不会执行。
var iconImagePattern = regexp.MustCompile(`^data:image/(?:png|jpeg|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,`)

// Agent 是一个自定义智能体定义。Tools、Skills 与 Connectors 为 nil 表示不限制。
// Icon 为空表示使用默认图标，否则是 Emoji/内置图标名或 data URL 图片。
type Agent struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Instruction string   `json:"instruction"`
	ProjectHash string   `json:"projectHash"`
	Icon        string   `json:"icon"`
	Tools       []string `json:"tools"`
	Skills      []string `json:"skills"`
	Connectors  []string `json:"connectors"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

// Input 是创建与全量替换共用的可编辑字段。
type Input struct {
	Name        string
	Instruction string
	ProjectHash string
	Icon        string
	Tools       []string
	Skills      []string
	Connectors  []string
}

// IsID 报告字符串是否是自定义智能体 id（同时作为工作区 hash 使用）。
func IsID(id string) bool {
	return idPattern.MatchString(id)
}

// CheckProject 校验绑定的项目 hash 是否能解析到已注册项目。
type CheckProject func(hash string) error

// Store 串行化 agents.json 的读改写。
type Store struct {
	mu   sync.Mutex
	path string
}

func New(home string) *Store {
	return &Store{path: filepath.Join(home, "agents.json")}
}

func (s *Store) load() ([]*Agent, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	var agents []*Agent
	if err := json.Unmarshal(data, &agents); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	return agents, nil
}

// List 按创建顺序返回全部定义。
func (s *Store) List() ([]*Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// Get 返回指定智能体；不存在返回 nil 且无错误。
func (s *Store) Get(id string) (*Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agents, err := s.load()
	if err != nil {
		return nil, err
	}
	for _, agent := range agents {
		if agent.ID == id {
			return agent, nil
		}
	}
	return nil, nil
}

// Create 校验并追加一个定义，id 与创建时间由 Store 生成。
func (s *Store) Create(in Input, now int64, check CheckProject) (*Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agents, err := s.load()
	if err != nil {
		return nil, err
	}
	if err := validate(in, agents, "", check); err != nil {
		return nil, err
	}
	agent := &Agent{
		ID:          newID(),
		Name:        strings.TrimSpace(in.Name),
		Instruction: in.Instruction,
		ProjectHash: strings.TrimSpace(in.ProjectHash),
		Icon:        strings.TrimSpace(in.Icon),
		Tools:       normalizeNames(in.Tools, true),
		Skills:      normalizeNames(in.Skills, false),
		Connectors:  normalizeNames(in.Connectors, false),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	agents = append(agents, agent)
	if err := repository.WriteJSON(s.path, agents); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	return agent, nil
}

// Update 全量替换可编辑字段并刷新 updatedAt，id 与 createdAt 保持不变。
func (s *Store) Update(id string, in Input, now int64, check CheckProject) (*Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agents, err := s.load()
	if err != nil {
		return nil, err
	}
	target := -1
	for i, agent := range agents {
		if agent.ID == id {
			target = i
			break
		}
	}
	if target < 0 {
		return nil, ErrNotFound
	}
	if err := validate(in, agents, id, check); err != nil {
		return nil, err
	}
	agent := agents[target]
	agent.Name = strings.TrimSpace(in.Name)
	agent.Instruction = in.Instruction
	agent.ProjectHash = strings.TrimSpace(in.ProjectHash)
	agent.Icon = strings.TrimSpace(in.Icon)
	agent.Tools = normalizeNames(in.Tools, true)
	agent.Skills = normalizeNames(in.Skills, false)
	agent.Connectors = normalizeNames(in.Connectors, false)
	agent.UpdatedAt = now
	if err := repository.WriteJSON(s.path, agents); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	return agent, nil
}

// Delete 移除定义；不存在时返回 ErrNotFound。
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agents, err := s.load()
	if err != nil {
		return err
	}
	kept := make([]*Agent, 0, len(agents))
	found := false
	for _, agent := range agents {
		if agent.ID == id {
			found = true
			continue
		}
		kept = append(kept, agent)
	}
	if !found {
		return ErrNotFound
	}
	if err := repository.WriteJSON(s.path, kept); err != nil {
		return fmt.Errorf("%w: %w", ErrStorage, err)
	}
	return nil
}

func validate(in Input, agents []*Agent, selfID string, check CheckProject) error {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return errors.New("名称不能为空")
	}
	if utf8.RuneCountInString(name) > nameMaxRunes {
		return fmt.Errorf("名称最长 %d 个字符", nameMaxRunes)
	}
	if name == reservedName {
		return fmt.Errorf("名称不能与内置智能体「%s」重复", reservedName)
	}
	for _, agent := range agents {
		if agent.ID != selfID && strings.EqualFold(agent.Name, name) {
			return fmt.Errorf("名称「%s」已被其他智能体使用", name)
		}
	}
	if utf8.RuneCountInString(in.Instruction) > instructionMaxRunes {
		return fmt.Errorf("角色与要求最长 %d 个字符", instructionMaxRunes)
	}
	if project := strings.TrimSpace(in.ProjectHash); project != "" && check != nil {
		if err := check(project); err != nil {
			return err
		}
	}
	return checkIcon(strings.TrimSpace(in.Icon))
}

// checkIcon 允许空值、Emoji 或内置图标名等短文本，以及一张不超过
// iconMaxBytes 的 data URL 图片。
func checkIcon(icon string) error {
	if icon == "" {
		return nil
	}
	if strings.HasPrefix(icon, "data:") {
		prefix := iconImagePattern.FindString(icon)
		if prefix == "" {
			return errors.New("图标仅支持 PNG / JPEG / GIF / WebP / AVIF / APNG / BMP / ICO / SVG 图片")
		}
		raw, err := base64.StdEncoding.DecodeString(icon[len(prefix):])
		if err != nil {
			return errors.New("图标图片不是有效的 base64 数据")
		}
		if len(raw) > iconMaxBytes {
			return fmt.Errorf("图标图片不能超过 %dKB", iconMaxBytes>>10)
		}
		return nil
	}
	if utf8.RuneCountInString(icon) > iconMaxRunes {
		return fmt.Errorf("图标文本最长 %d 个字符", iconMaxRunes)
	}
	return nil
}

// normalizeNames 去掉空白与重复项；resolve 为 true 时按工具名规范归一。
// nil 输入保持 nil，表示「不限制」。
func normalizeNames(names []string, resolve bool) []string {
	if names == nil {
		return nil
	}
	out := make([]string, 0, len(names))
	seen := map[string]bool{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if resolve {
			name = tools.ResolveName(name)
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

func newID() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return "agent_" + hex.EncodeToString(buf)
}
