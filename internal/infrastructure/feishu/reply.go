package feishu

import (
	"context"
	"fmt"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/larksuite/oapi-sdk-go/v3/channel/normalize"
	"github.com/larksuite/oapi-sdk-go/v3/channel/outbound"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func replyMarkdown(ctx context.Context, client *lark.Client, messageID, markdown string) error {
	for _, chunk := range outbound.SplitWithCodeFences(markdown, 3500) {
		// 由飞书原生渲染 Markdown；text 消息会把格式标记直接展示给用户。
		content, err := normalize.SimpleMarkdownToPost("", chunk, nil)
		if err != nil {
			return fmt.Errorf("format feishu markdown: %w", err)
		}
		result, err := client.Im.Message.Reply(ctx, larkim.NewReplyMessageReqBuilder().MessageId(messageID).
			Body(larkim.NewReplyMessageReqBodyBuilder().MsgType("post").Content(content).Build()).Build())
		if err != nil {
			return fmt.Errorf("reply feishu markdown: %w", err)
		}
		if result == nil || !result.Success() {
			code := -1
			if result != nil {
				code = result.Code
			}
			return fmt.Errorf("feishu markdown reply failed: code=%d", code)
		}
	}
	return nil
}
