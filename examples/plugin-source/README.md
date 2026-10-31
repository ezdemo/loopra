# Loopra 插件源

将此目录的内容放到 GitHub 仓库（如 `ezdemo/loopra-plugins`），提交后即可在 Loopra 的「技能与插件 → 发现 → 插件」中使用。

每个插件放在 `plugins/<目录名>/` 下，包含具有唯一 `name` 的 `package.json` 和插件入口。`description`、`version` 显示在列表中。无需维护索引文件。

添加插件后，在 Loopra 中刷新列表，点击「安装」。在「我的内容 → 插件」中启停、设置或卸载，发现页也可直接卸载已安装的外部插件；移除源会保留已安装插件。

工具、Hook 优先级与合并规则、图标、设置页、纯聊天右侧插件面板和宿主服务见[插件开发文档](../../docs/PLUGIN.md)。
