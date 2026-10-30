package provider

import (
	"sync"

	"google.golang.org/adk/v2/model"
)

// wireBodies 保存插件为某一次模型调用替换的 POST JSON。
// 键是这次的请求指针。适配器通过 outgoingBody 取走；没人取的话，
// 钩子会在本轮结束时清掉。
var wireBodies sync.Map

// SetWireBody 登记这一次请求要发出去的 JSON。body 为 nil 时删掉已有记录。
func SetWireBody(req *model.LLMRequest, body map[string]any) {
	if req == nil {
		return
	}
	if body == nil {
		wireBodies.Delete(req)
		return
	}
	wireBodies.Store(req, body)
}

// TakeWireBody 取走并删除这一次请求的替换 JSON。
func TakeWireBody(req *model.LLMRequest) (map[string]any, bool) {
	if req == nil {
		return nil, false
	}
	value, ok := wireBodies.LoadAndDelete(req)
	if !ok {
		return nil, false
	}
	body, _ := value.(map[string]any)
	return body, body != nil
}

// outgoingBody 在适配器编好请求后调用。插件提供了替换 JSON 时用那一份，
// 否则用适配器自己编出来的。即使编码失败也会把记录取走，避免留下悬挂项。
func outgoingBody(req *model.LLMRequest, built map[string]any, err error) (map[string]any, error) {
	wire, ok := TakeWireBody(req)
	if err != nil {
		return nil, err
	}
	if ok {
		return wire, nil
	}
	return built, nil
}
