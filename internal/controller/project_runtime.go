package controller

import (
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/schedule"
	"github.com/ezdemo/looprax/internal/service/subagent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// ProjectRuntime 是一个工作区自己的智能体、工具和权限。
// HTTP 控制器按工作区取出它，再套到这一次请求上。
//
// anchor 是工具回调捕获的那个控制器。回调要看到这个工作区的智能体，
// 所以它留下来；它不负责处理 HTTP。
type ProjectRuntime struct {
	agent       *agentpkg.Agent
	registry    *tools.Registry
	permissions *hitl.Registry
	tasks       *schedule.Service
	approval    *hitl.Policy
	subRunner   *subagent.Runner
	anchor      *Controller
}

func newProjectRuntime(anchor *Controller) *ProjectRuntime {
	rt := &ProjectRuntime{anchor: anchor}
	rt.sync()
	return rt
}

func (rt *ProjectRuntime) sync() {
	if rt == nil || rt.anchor == nil {
		return
	}
	s := rt.anchor
	rt.agent = s.agent
	rt.registry = s.registry
	rt.permissions = s.permissions
	rt.tasks = s.tasks
	rt.approval = s.approvalPolicy
	rt.subRunner = s.subRunner
}

// view 复制锚点控制器，并换上这次请求的配置快照。
// 工作区目录仍以锚点为准，避免全局配置把项目路径盖掉。
func (rt *ProjectRuntime) view(cfg *config.Loopra) *Controller {
	view := *rt.anchor
	view.cfg = cfg
	if view.cfg != nil {
		view.cfg.WorkspaceDir = rt.anchor.workspaceRoot()
	}
	return &view
}
