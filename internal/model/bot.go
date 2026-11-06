package model

import "encoding/json"

// Bot 的凭证只写入本地配置，不作为 HTTP 响应返回。
type Bot struct {
	ID             string                     `json:"id"`
	Name           string                     `json:"name"`
	Platform       string                     `json:"platform"`
	AppID          string                     `json:"appId"`
	AppSecret      string                     `json:"appSecret"`
	OwnerID        string                     `json:"ownerId"`
	TenantBrand    string                     `json:"tenantBrand"`
	WorkspaceHash  string                     `json:"workspaceHash"`
	Enabled        bool                       `json:"enabled"`
	AllowedUserIDs []string                   `json:"allowedUserIds"`
	AllowedChatIDs []string                   `json:"allowedChatIds"`
	Chats          []BotChat                  `json:"chats"`
	SeenMessages   []string                   `json:"seenMessages"`
	CreatedAt      int64                      `json:"createdAt"`
	UpdatedAt      int64                      `json:"updatedAt"`
	Extra          map[string]json.RawMessage `json:"-"`
}

type BotChat struct {
	ChatID      string `json:"chatId"`
	SessionName string `json:"sessionName"`
	ChatType    string `json:"chatType"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// 保留新版本写入的未知配置，避免旧版本保存时丢失字段。
func (b *Bot) UnmarshalJSON(data []byte) error {
	type plain Bot
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	known, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(known, &keys); err != nil {
		return err
	}
	for key := range keys {
		delete(fields, key)
	}
	*b = Bot(value)
	b.Extra = fields
	return nil
}

func (b Bot) MarshalJSON() ([]byte, error) {
	type plain Bot
	data, err := json.Marshal(plain(b))
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	for key, value := range b.Extra {
		if _, known := fields[key]; !known {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}

type BotCredentials struct {
	AppID, AppSecret, OwnerID, TenantBrand string
}

type BotMessage struct {
	ID, ChatID, ChatType, UserID, Text string
	MentionedBot                       bool
	HasAttachments                     bool
}
