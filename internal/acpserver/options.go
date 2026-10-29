package acpserver

import (
	acpsdk "github.com/coder/acp-go-sdk"

	modelconfig "github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

func sessionOptions(cfg *modelconfig.Loopra, mode, modelValue, effort string, fast, plan bool) []acpsdk.SessionConfigOption {
	if cfg == nil {
		fallback := modelconfig.Default()
		cfg = &fallback
	}
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
	efforts := acpsdk.SessionConfigSelectOptionsUngrouped{}
	for _, value := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"} {
		efforts = append(efforts, acpsdk.SessionConfigSelectOption{Value: acpsdk.SessionConfigValueId(value), Name: value})
	}
	if effort == "" {
		effort = "high"
	}
	out = append(out, selectOption("effort", "思考强度", "thought_level", effort, efforts))
	toggles := acpsdk.SessionConfigSelectOptionsUngrouped{
		{Value: "off", Name: "关闭"},
		{Value: "on", Name: "开启"},
	}
	fastValue := "off"
	if fast {
		fastValue = "on"
	}
	planValue := "off"
	if plan {
		planValue = "on"
	}
	out = append(out,
		selectOption("fast", "快速模式", "model_config", fastValue, toggles),
		selectOption("plan", "计划模式", "_plan", planValue, toggles),
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

func sessionInstruction(base string, plan bool) string {
	if !plan {
		return base
	}
	return base + "\n当前为计划模式：只进行只读探索并制定计划，使用 submit_plan 提交，禁止修改文件和执行写入命令。"
}
