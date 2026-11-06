// Package feishu 将官方 SDK 的扫码与长连接适配为 Loopra 的机器人端口。
package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ezdemo/looprax/internal/model"
	lark "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/larksuite/oapi-sdk-go/v3/channel/normalize"
	core "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

type Provider struct{}

func (Provider) Register(ctx context.Context, appID, name string, qr func(string, int)) (model.BotCredentials, error) {
	preset := false
	result, err := registration.RegisterApp(ctx, &registration.Options{
		Source: "loopra", AppID: appID, CreateOnly: appID == "",
		AppPreset: &registration.AppPreset{Name: name, Desc: "Loopra AI 编码助手"},
		Addons: &registration.AppAddons{
			Preset: &preset,
			Scopes: registration.AppAddonsScopes{Tenant: []string{
				"im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly",
			}},
			Events: registration.AppAddonsEvents{Items: registration.AppAddonsEventItems{Tenant: []string{"im.message.receive_v1"}}},
		},
		OnQRCode: func(info *registration.QRCodeInfo) { qr(info.URL, info.ExpireIn) },
	})
	if err != nil {
		return model.BotCredentials{}, err
	}
	credentials := model.BotCredentials{AppID: result.ClientID, AppSecret: result.ClientSecret}
	if result.UserInfo != nil {
		credentials.OwnerID, credentials.TenantBrand = result.UserInfo.OpenID, result.UserInfo.TenantBrand
	}
	return credentials, nil
}

func (Provider) Connect(ctx context.Context, record model.Bot, receive func(context.Context, model.BotMessage, func(context.Context, string) error) error, state func(string)) error {
	domain := "https://open.feishu.cn"
	if record.TenantBrand == "lark" {
		domain = "https://open.larksuite.com"
	}
	httpClient := &http.Client{Timeout: 30 * time.Second}
	client := lark.NewClient(record.AppID, record.AppSecret, lark.WithLogLevel(core.LogLevelError), lark.WithOpenBaseUrl(domain), lark.WithHttpClient(httpClient))
	response, err := client.Get(ctx, "/open-apis/bot/v3/info", nil, core.AccessTokenTypeTenant)
	if err != nil {
		return fmt.Errorf("get bot identity: %w", err)
	}
	var identity struct {
		Code int `json:"code"`
		Bot  struct {
			OpenID string `json:"open_id"`
		} `json:"bot"`
	}
	if response == nil || json.Unmarshal(response.RawBody, &identity) != nil || identity.Code != 0 || identity.Bot.OpenID == "" {
		return fmt.Errorf("invalid bot identity response")
	}
	// 直接使用 SDK 事件分发，每条消息独立鉴权；不使用跨发送者的合并队列。
	handler := dispatcher.NewEventDispatcher("", "").OnP2MessageReceiveV1(func(eventCtx context.Context, event *larkim.P2MessageReceiveV1) error {
		message := normalize.ParseMessage(event)
		if message == nil || message.UserID == identity.Bot.OpenID || message.MentionAll ||
			(message.CreateTimeMs > 0 && time.Since(time.UnixMilli(message.CreateTimeMs)) > 30*time.Minute) {
			return nil
		}
		for _, mention := range message.Mentions {
			if mention.OpenID == identity.Bot.OpenID || mention.UserID == identity.Bot.OpenID {
				message.MentionedBot = true
			}
		}
		return receive(eventCtx, model.BotMessage{
			ID: message.MessageID, ChatID: message.ChatID, ChatType: message.ChatType,
			UserID: message.UserID, Text: message.Content, MentionedBot: message.MentionedBot,
			HasAttachments: len(message.Resources) > 0,
		}, func(replyCtx context.Context, text string) error {
			return replyMarkdown(replyCtx, client, message.MessageID, text)
		})
	})
	ws := larkws.NewClient(record.AppID, record.AppSecret, larkws.WithLogLevel(core.LogLevelError),
		larkws.WithDomain(domain), larkws.WithHttpClient(httpClient), larkws.WithEventHandler(handler),
		larkws.WithOnReady(func() { state("connected") }),
		larkws.WithOnReconnected(func() { state("connected") }),
		larkws.WithOnReconnecting(func() { state("reconnecting") }),
		larkws.WithOnDisconnected(func() { state("offline") }),
		larkws.WithOnError(func(error) { state("reconnecting") }))
	return ws.Start(ctx)
}
