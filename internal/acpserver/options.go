package acpserver

import (
	"slices"

	acpsdk "github.com/coder/acp-go-sdk"

	modelconfig "github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

func sessionOptions(cfg *modelconfig.Loopra, mode, channelID, modelName, effort string, fast bool) []acpsdk.SessionConfigOption {
	if cfg == nil {
		fallback := modelconfig.Default()
		cfg = &fallback
	}
	modelValue := channelID + ":" + modelName
	out := []acpsdk.SessionConfigOption{}
	models := acpsdk.SessionConfigSelectOptionsUngrouped{}
	for _, channel := range cfg.ModelChannels {
		for _, model := range channel.Models {
			label := model.DisplayName
			if label == "" {
				label = model.Name
			}
			models = append(models, acpsdk.SessionConfigSelectOption{
				Value: acpsdk.SessionConfigValueId(channel.ID + ":" + model.Name),
				Name:  channel.Name + " / " + label,
			})
		}
	}
	if len(models) == 0 && modelValue != "" && modelValue != ":" {
		models = append(models, acpsdk.SessionConfigSelectOption{
			Value: acpsdk.SessionConfigValueId(modelValue), Name: modelValue,
		})
	}
	if len(models) > 0 {
		out = append(out, selectOption("model", "模型", "model", modelValue, models))
	}
	out = append(out, selectOption("mode", "权限模式", "mode", hitl.NormalizeMode(mode), acpsdk.SessionConfigSelectOptionsUngrouped{
		{Value: hitl.ModeApproval, Name: "按需审批", Description: acpsdk.Ptr("需要授权的工具操作由用户审批")},
		{Value: hitl.ModeAuto, Name: "自动审批", Description: acpsdk.Ptr("使用 Loopra 的自动审批策略")},
		{Value: hitl.ModeFree, Name: "完全自动", Description: acpsdk.Ptr("不进行工具权限审批")},
	}))
	levels := cfg.ReasoningEffortsFor(channelID, modelName)
	choices := modelconfig.ReasoningEffortChoices(levels)
	efforts := acpsdk.SessionConfigSelectOptionsUngrouped{}
	for _, value := range choices {
		efforts = append(efforts, acpsdk.SessionConfigSelectOption{Value: acpsdk.SessionConfigValueId(value), Name: value})
	}
	if levels == nil && effort != "" && !slices.Contains(choices, effort) {
		// 未配置目录的模型允许自由取值：当前自定义强度仍展示为可选项。
		efforts = append(efforts, acpsdk.SessionConfigSelectOption{Value: acpsdk.SessionConfigValueId(effort), Name: effort})
	}
	if len(efforts) > 0 {
		if effort == "" {
			effort = "high"
		}
		out = append(out, selectOption("effort", "思考强度", "thought_level", effort, efforts))
	}
	toggles := acpsdk.SessionConfigSelectOptionsUngrouped{
		{Value: "off", Name: "关闭"},
		{Value: "on", Name: "开启"},
	}
	fastValue := "off"
	if fast {
		fastValue = "on"
	}
	out = append(out,
		selectOption("fast", "快速模式", "model_config", fastValue, toggles),
	)
	return out
}

func selectOption(id, name, category, current string, options acpsdk.SessionConfigSelectOptionsUngrouped) acpsdk.SessionConfigOption {
	cat := acpsdk.SessionConfigOptionCategory(category)
	choices := options
	return acpsdk.SessionConfigOption{Select: &acpsdk.SessionConfigOptionSelect{
		Id: acpsdk.SessionConfigId(id), Name: name, Type: "select",
		Category: &cat, CurrentValue: acpsdk.SessionConfigValueId(current),
		Options: acpsdk.SessionConfigSelectOptions{Ungrouped: &choices},
	}}
}
