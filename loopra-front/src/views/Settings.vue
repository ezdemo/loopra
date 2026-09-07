<template>
  <div class="settings-page" :class="{ 'market-only': marketOnly }">
    <!-- 左侧导航 -->
    <nav v-if="!marketOnly" class="settings-nav">
      <div class="nav-header">
        <svg fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="16">
          <circle cx="12" cy="12" r="3"/>
          <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>设置</span>
      </div>

      <div class="nav-items">
        <button
            v-for="tab in tabs"
            :key="tab.id"
            :class="{ active: activeTab === tab.id }"
            class="nav-item"
            @click="activeTab = tab.id"
        >
          <span class="nav-icon" v-html="tab.icon"></span>
          <span class="nav-label">{{ tab.label }}</span>
          <span v-if="tab.badge" class="nav-badge">{{ tab.badge }}</span>
        </button>
      </div>

      </nav>

    <!-- 主内容区 -->
    <main class="settings-main">
      <!-- 顶部操作栏 -->
      <header v-if="!marketOnly && activeTab !== 'model-channels' && activeTab !== 'tools' && activeTab !== 'sub-agents' && activeTab !== 'dashboard'" class="settings-header">
        <div class="header-title">
          <h2>{{ currentTab?.label || '设置' }}</h2>
          <p class="header-desc">{{ currentTab?.description }}</p>
        </div>
        <div v-if="activeTab !== 'openapi' && activeTab !== 'mcp' && activeTab !== 'lsp' && activeTab !== 'skill-market' && activeTab !== 'plugins' && activeTab !== 'extpacks' && activeTab !== 'about' && activeTab !== 'pet' && activeTab !== 'prompt' && activeTab !== 'model-channels' && activeTab !== 'tools' && activeTab !== 'sub-agents' && activeTab !== 'dashboard'" class="header-actions">
          <button v-if="activeTab === 'ai'" class="btn btn-secondary" style="padding:6px 12px;" @click="openAutoFillDialog" title="自动填入配置">
            <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            自动填入
          </button>
          <button :disabled="loading || !hasChanges" class="btn btn-primary" @click="saveSettings">
            <svg v-if="!loading" fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
                 width="14">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            <svg v-else class="animate-spin" fill="none" height="14" stroke="currentColor" stroke-width="2"
                 viewBox="0 0 24 24"
                 width="14">
              <path d="M21 12a9 9 0 11-6.219-8.56"/>
            </svg>
            {{ loading ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </header>

      <!-- 设置内容区 -->
      <div class="settings-content">
        <!-- 基本设置 -->
        <section v-if="activeTab === 'general'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <h3>外观设置</h3>
              <p>自定义界面主题</p>
            </div>
            <div class="card-body">
              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">界面主题</label>
                  <p class="setting-hint">选择适合你的视觉风格</p>
                </div>
                <div class="setting-control">
                  <div class="theme-grid">
                    <button
                        v-for="theme in themes"
                        :key="theme.value"
                        :class="{ active: settings.theme === theme.value }"
                        class="theme-option"
                        @click="settings.theme = theme.value"
                    >
                      <span :class="theme.value" class="theme-preview"></span>
                      <span class="theme-name">{{ theme.label }}</span>
                    </button>
                  </div>
                </div>
              </div>
              <!-- 中文字体切换仅桌面端可用（主进程枚举系统字体）；Web 端不提供 -->
              <div v-if="isDesktop" class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">中文字体</label>
                  <p class="setting-hint">界面中文字体（英文/数字保持 JetBrains Mono）</p>
                </div>
                <div class="setting-control">
                  <div class="select-wrapper">
                    <select v-model="settings.fontFamily" class="form-select" style="min-width:200px">
                      <option value="system">跟随系统（默认）</option>
                      <optgroup v-if="systemFonts.length" label="系统已安装字体">
                        <option v-for="name in systemFonts" :key="name" :value="name">{{ name }}</option>
                      </optgroup>
                    </select>
                    <svg class="select-arrow" fill="none" height="12" stroke="currentColor" stroke-width="2"
                         viewBox="0 0 24 24" width="12">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 插件运行时 -->
        <section v-if="activeTab === 'plugins'" class="settings-section">
          <div class="section-card plugin-card">
            <div class="card-header plugin-header">
              <div>
                <h3>运行时插件</h3>
                <p>管理当前进程中的 Cutin 插件</p>
              </div>
              <button class="btn-icon-xs" title="刷新" :disabled="pluginsLoading" @click="loadPlugins">
                <svg :class="{'animate-spin': pluginsLoading}" fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                  <path d="M1 4v6h6M23 20v-6h-6"/>
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/>
                </svg>
              </button>
            </div>
            <div class="card-body plugin-list">
              <div v-if="pluginsLoading && plugins.length === 0" class="plugin-empty">正在加载插件...</div>
              <div v-else-if="plugins.length === 0" class="plugin-empty">暂无已注册插件</div>
              <div v-for="plugin in plugins" v-else :key="plugin.id" class="plugin-row">
                <div class="plugin-info">
                  <div class="plugin-title">
                    <span>{{ plugin.displayName }}</span>
                    <code>{{ plugin.id }}</code>
                  </div>
                  <p v-if="plugin.remark" class="plugin-remark">{{ plugin.remark }}</p>
                  <div class="plugin-meta" :title="plugin.className">
                    <span>{{ plugin.className }}</span>
                    <span>顺序 {{ plugin.order }}</span>
                  </div>
                </div>
                <div class="plugin-runtime">
                  <span class="plugin-instances" :class="{active: plugin.enabled}">
                    {{ plugin.activeInstances }}/{{ plugin.totalInstances }} 实例
                  </span>
                  <label class="toggle-switch" :class="{disabled: pluginToggling === plugin.id}">
                    <input
                        type="checkbox"
                        :checked="plugin.enabled"
                        :disabled="pluginToggling === plugin.id"
                        @change="togglePlugin(plugin, $event.target.checked)"
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 拓展包（Solon H-SPI） -->
        <section v-if="activeTab === 'extpacks'" class="settings-section">
          <div class="section-card plugin-card">
            <div class="card-header plugin-header">
              <div>
                <h3>拓展包</h3>
                <p>Solon H-SPI 拓展包：安装 jar 即扩展 Agent 工具与拦截能力（~/.loopra/extpacks）</p>
              </div>
              <button class="btn-icon-xs" title="刷新" :disabled="extPacksLoading" @click="loadExtPacks">
                <svg :class="{'animate-spin': extPacksLoading}" fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                  <path d="M1 4v6h6M23 20v-6h-6"/>
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/>
                </svg>
              </button>
            </div>
            <div class="card-body">
              <div class="input-group" style="margin-bottom:12px;">
                <input
                  v-model="extPackSource"
                  class="form-input"
                  placeholder="http(s)://.../xxx.jar 直链 或 本地 jar 路径"
                  type="text"
                  @keyup.enter="installExtPack"
                />
                <button v-if="isDesktop" class="btn btn-secondary" title="选择本地 jar 文件" @click="chooseExtPackFile">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  选择文件
                </button>
                <button class="btn btn-secondary" :disabled="extPackInstalling" @click="installExtPack">
                  <svg v-if="extPackInstalling" class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  {{ extPackInstalling ? '安装中' : '安装' }}
                </button>
              </div>
              <div class="plugin-list">
                <div v-if="extPacksLoading && extPacks.length === 0" class="plugin-empty">正在加载拓展包...</div>
                <div v-else-if="extPacks.length === 0" class="plugin-empty">暂无已安装拓展包，粘贴上方 jar 地址安装</div>
                <div v-for="pack in extPacks" v-else :key="pack.id" class="plugin-row">
                  <div class="plugin-info">
                    <div class="plugin-title">
                      <span>{{ pack.id }}</span>
                      <code>v{{ pack.version }}</code>
                    </div>
                    <p v-if="pack.sourceUrl" class="plugin-remark" :title="pack.sourceUrl">{{ pack.sourceUrl }}</p>
                    <div class="plugin-meta">
                      <span class="plugin-instances" :class="{active: pack.started}">{{ pack.started ? '运行中' : '已停止' }}</span>
                      <span>{{ pack.bridgeCount }} 个桥接</span>
                      <span v-if="pack.bridgeClasses && pack.bridgeClasses.length" :title="pack.bridgeClasses.join('\n')">{{ pack.bridgeClasses.length }} 个桥接类</span>
                    </div>
                  </div>
                  <div class="plugin-runtime">
                    <button
                      class="btn btn-ghost btn-sm"
                      style="color:var(--red)"
                      :disabled="extPackAction === pack.id"
                      @click="uninstallExtPack(pack)"
                      title="卸载拓展包"
                    >卸载</button>
                    <label class="toggle-switch" :class="{disabled: extPackAction === pack.id}" title="启用后立即启动，停用后立即停止">
                      <input
                        type="checkbox"
                        :checked="pack.enabled"
                        :disabled="extPackAction === pack.id"
                        @change="toggleExtPack(pack, $event.target.checked)"
                      />
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 宠物设置 -->
        <section v-if="activeTab === 'pet'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <h3>宠物选择</h3>
              <p class="card-header-row">选择一个桌面宠物陪你工作
                <span class="pet-top-bar">
                  <button class="btn btn-ghost" @click="openPetWebsite">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                      <polyline points="15 3 21 3 21 9"/>
                      <line x1="10" x2="21" y1="14" y2="3"/>
                    </svg>
                    去网站看看
                  </button>
                  <button v-if="isElectron" class="btn btn-ghost" :disabled="!activePetName" @click="toggleDesktopPet">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <rect x="3" y="3" width="18" height="14" rx="2"/>
                      <path d="M8 21h8M12 17v4"/>
                    </svg>
                    {{ desktopPetVisible ? '隐藏桌面宠物' : '显示到桌面' }}
                  </button>
                  <button v-if="isElectron" class="btn btn-ghost" :disabled="!activePetName" @click="resetPetPosition">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M12 21s-7-5.1-7-11a7 7 0 0 1 14 0c0 5.9-7 11-7 11z"/>
                      <circle cx="12" cy="10" r="2.5"/>
                    </svg>
                    重置位置
                  </button>
                  <button v-if="!isElectron" class="btn btn-ghost" @click="toggleWebPet">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                    {{ store.petHidden ? '显示聊天宠物' : '隐藏聊天宠物' }}
                  </button>
                  <button class="btn btn-ghost" @click="loadPets">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M1 4v6h6M23 20v-6h-6"/>
                      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                    </svg>
                    刷新
                  </button>
                </span>
              </p>
            </div>
            <div class="card-body">
              <div v-if="petsLoading" class="pets-loading">
                <span class="loading-dot"></span> 加载宠物列表...
              </div>
              <div v-else-if="petsError" class="pets-error">
                <p>{{ petsError }}</p>
              </div>
              <div v-else-if="petsList.length === 0" class="pets-empty">
                <div class="empty-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                    <path d="M12 2C8 2 4 5 4 9c0 3 2 6 4 8l4 5 4-5c2-2 4-5 4-8 0-4-4-7-8-7z"/>
                  </svg>
                </div>
                <p>暂无可用的宠物</p>
                <p class="hint">请将宠物文件夹放入 ~/.petdex/pets/ 目录</p>
                <!-- 无宠物时显示初始化按钮 -->
                <div class="pet-init-inline">
                  <button :disabled="petIniting" class="btn btn-secondary" @click="initPet">
                    <svg v-if="petIniting" class="animate-spin" fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    <svg v-else fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M12 2C8 2 4 5 4 9c0 3 2 6 4 8l4 5 4-5c2-2 4-5 4-8 0-4-4-7-8-7z"/>
                      <line x1="12" y1="9" x2="12" y2="15"/>
                      <line x1="9" y1="12" x2="15" y2="12"/>
                    </svg>
                    {{ petIniting ? '初始化中...' : '初始化宠物' }}
                  </button>
                  <span class="pet-init-hint">通过 npx petdex 快速安装一个默认宠物</span>
                </div>
              </div>
              <div v-else class="pets-grid">
                <div
                    v-for="pet in petsList"
                    :key="pet.name"
                    :class="{ 'pet-active': activePetName === pet.name, 'pet-no-spritesheet': !pet.hasSpritesheet }"
                    class="pet-card"
                    @click="selectPet(pet.name)"
                >
                  <!-- 宠物预览 -->
                  <div class="pet-preview" title="点击切换动画">
                    <PetSprite
                        v-if="pet.hasSpritesheet"
                        :spritesheet-url="pet.spritesheetUrl + '?t=' + Date.now()"
                        :state="activePetName === pet.name ? activePetAnim : 'idle'"
                        :initial-size-index="0"
                    />
                    <div v-else class="pet-no-sprite-placeholder">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                        <path d="M12 2C8 2 4 5 4 9c0 3 2 6 4 8l4 5 4-5c2-2 4-5 4-8 0-4-4-7-8-7z"/>
                      </svg>
                    </div>
                  </div>
                  <!-- 宠物信息 -->
                  <div class="pet-info">
                    <div class="pet-name">{{ pet.displayName || pet.name }}</div>
                    <div v-if="pet.description" class="pet-desc">{{ pet.description }}</div>
                  </div>
                  <!-- 选中标识 -->
                  <div v-if="activePetName === pet.name" class="pet-check">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent)" stroke="white" stroke-width="3">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="8 12 11 15 16 9" stroke="white" fill="none"/>
                    </svg>
                  </div>
                  <!-- 删除按钮 -->
                  <button class="pet-delete-btn" title="删除此宠物" @click.stop="deletePet(pet.name)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 服务器设置 -->
        <section v-if="activeTab === 'server'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <h3>连接设置</h3>
              <p>配置后端 Loopra 服务的连接参数</p>
            </div>
            <div class="card-body">
              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">API 地址</label>
                  <p class="setting-hint">留空使用默认值（{{ DEFAULT_API_BASE }}）</p>
                </div>
                <div class="setting-control">
                  <div class="input-group">
                    <input
                        v-model="settings.server.apiBaseUrl"
                        class="form-input"
                        :placeholder="DEFAULT_API_BASE"
                        type="text"
                    />
                    <button
                        :disabled="checkingConnection"
                        class="btn btn-secondary"
                        @click="checkServerConnection"
                    >
                      <svg v-if="checkingConnection" class="animate-spin" fill="none" height="14" stroke="currentColor"
                           stroke-width="2" viewBox="0 0 24 24" width="14">
                        <path d="M21 12a9 9 0 11-6.219-8.56"/>
                      </svg>
                      <svg v-else fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
                           width="14">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                      </svg>
                      {{ checkingConnection ? '检测中...' : '测试连接' }}
                    </button>
                  </div>
                </div>
              </div>

              <div v-if="connectionChecked" class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">连接状态</label>
                </div>
                <div class="setting-control">
                  <div :class="{ ok: connectionOk, error: !connectionOk }" class="connection-status">
                    <span class="status-dot"></span>
                    <span>{{ connectionOk ? '连接成功' : '连接失败' }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- AI 设置 -->
        <section v-if="activeTab === 'ai'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <h3>模型配置</h3>
              <p>配置 LLM API 连接与模型参数</p>
            </div>
            <div class="card-body">
              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">API 地址</label>
                  <p class="setting-hint">OpenAI 兼容 API 的基础 URL</p>
                </div>
                <div class="setting-control">
                  <input
                      v-model="settings.ai.baseUrl"
                      class="form-input"
                      placeholder="https://api.openai.com/v1"
                      type="text"
                  />
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">API 密钥</label>
                  <p class="setting-hint">用于身份验证的密钥</p>
                </div>
                <div class="setting-control">
                  <div class="input-with-toggle">
                    <input
                        v-model="settings.ai.apiKey"
                        autocomplete="new-password"
                        :type="showApiKey ? 'text' : 'password'"
                        class="form-input"
                        placeholder="sk-..."
                    />
                    <button
                        :title="showApiKey ? '隐藏' : '显示'"
                        class="toggle-visibility"
                        @click="showApiKey = !showApiKey"
                    >
                      <svg v-if="showApiKey" fill="none" height="14" stroke="currentColor" stroke-width="2"
                           viewBox="0 0 24 24" width="14">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                      <svg v-else fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
                           width="14">
                        <path
                            d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                        <line x1="1" x2="23" y1="1" y2="23"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">模型</label>
                  <p class="setting-hint">选择要使用的 AI 模型</p>
                </div>
                <div class="setting-control">
                  <div class="select-wrapper">
                    <select v-model="settings.ai.model" class="form-select">
                      <option v-for="model in availableModels" :key="model.name" :value="model.name">
                        {{ model.name }}
                      </option>
                    </select>
                    <svg class="select-arrow" fill="none" height="12" stroke="currentColor" stroke-width="2"
                         viewBox="0 0 24 24" width="12">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">推理强度</label>
                  <p class="setting-hint">AI 推理的详细程度</p>
                </div>
                <div class="setting-control reasoning-effort-control">
                  <div class="reasoning-slider" :style="{ '--effort-progress': `${reasoningEffortProgress}%` }">
                    <div class="reasoning-slider-summary">
                      <span class="reasoning-slider-value">{{ selectedReasoningEffort.label }}</span>
                      <span>{{ selectedReasoningEffort.description }}</span>
                    </div>
                    <div class="reasoning-slider-track">
                      <input
                          :value="reasoningEffortIndex"
                          aria-label="推理强度"
                          class="reasoning-slider-input"
                          max="5"
                          min="0"
                          step="1"
                          type="range"
                          @input="setReasoningEffort($event.target.value)"
                      />
                      <div aria-hidden="true" class="reasoning-slider-ticks">
                        <span v-for="(_, index) in reasoningEffortLevels" :key="index"
                              :class="{ active: index <= reasoningEffortIndex }"></span>
                      </div>
                    </div>
                    <div class="reasoning-slider-levels">
                      <button
                          v-for="(level, index) in reasoningEffortLevels"
                          :key="level.value"
                          :aria-pressed="index === reasoningEffortIndex"
                          :class="{ active: index === reasoningEffortIndex }"
                          type="button"
                          @click="setReasoningEffort(index)"
                      >
                        {{ level.shortLabel }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">可用模型列表</label>
                  <p class="setting-hint">每行一个模型名称，可查看远端模型后勾选填入</p>
                </div>
                <div class="setting-control">
                  <div class="input-group" style="align-items:stretch;">
                    <textarea
                        v-model="settings.ai.availableModelsText"
                        class="form-textarea"
                        placeholder="deepseek-v4-flash&#10;gpt-4&#10;gpt-4-turbo"
                        rows="4"
                        style="flex:1;"
                    ></textarea>
                    <button
                        :disabled="remoteModelsLoading"
                        class="btn btn-secondary"
                        style="padding:6px;"
                        @click="openRemoteModelsDialog"
                        title="查看远端模型列表"
                    >
                      <svg v-if="remoteModelsLoading" class="animate-spin" fill="none" height="16" stroke="currentColor"
                           stroke-width="2" viewBox="0 0 24 24" width="16">
                        <path d="M21 12a9 9 0 11-6.219-8.56"/>
                      </svg>
                      <svg v-else fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"
                           width="16">
                        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 模型价格配置 -->
          <div class="section-card" style="margin-top:16px;">
            <div class="card-header">
              <h3>模型价格（元/百万 tokens）</h3>
              <p>配置各模型的输入/缓存/输出价格，用于费用统计</p>
            </div>
            <div class="card-body">
              <div class="price-table-wrap">
                <table class="price-table" v-if="Object.keys(settings.ai.prices).length > 0">
                  <thead>
                    <tr>
                      <th class="price-th-model">模型名称</th>
                      <th class="price-th-num">输入 (input)</th>
                      <th class="price-th-num">缓存 (cache)</th>
                      <th class="price-th-num">输出 (output)</th>
                      <th class="price-th-action"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(price, modelName) in settings.ai.prices" :key="modelName">
                      <td class="price-td-model">
                        <input
                          :value="modelName"
                          class="form-input price-model-input"
                          :placeholder="'模型名称'"
                          @input="e => renamePriceModel(modelName, e.target.value)"
                        />
                      </td>
                      <td class="price-td-num">
                        <input
                          :value="price.input"
                          class="form-input price-num-input"
                          placeholder="0"
                          type="number"
                          min="0"
                          step="0.001"
                          @input="updatePriceValue(modelName, 'input', $event.target.value)"
                        />
                      </td>
                      <td class="price-td-num">
                        <input
                          :value="price.cache"
                          class="form-input price-num-input"
                          placeholder="0"
                          type="number"
                          min="0"
                          step="0.001"
                          @input="updatePriceValue(modelName, 'cache', $event.target.value)"
                        />
                      </td>
                      <td class="price-td-num">
                        <input
                          :value="price.output"
                          class="form-input price-num-input"
                          placeholder="0"
                          type="number"
                          min="0"
                          step="0.001"
                          @input="updatePriceValue(modelName, 'output', $event.target.value)"
                        />
                      </td>
                      <td class="price-td-action">
                        <button class="btn-icon-xs" style="color:var(--danger);" @click="removePriceModel(modelName)" title="删除此模型价格">×</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="price-empty">
                  <p>暂无价格配置。添加模型价格以启用费用统计。</p>
                </div>
                <div class="price-actions">
                  <button class="btn btn-sm" @click="addPriceModel">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12" style="margin-right:4px;">
                      <line x1="12" x2="12" y1="5" y2="19"/>
                      <line x1="5" x2="19" y1="12" y2="12"/>
                    </svg>
                    添加模型价格
                  </button>
                  <button class="btn btn-sm" @click="fillPricesFromModels">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12" style="margin-right:4px;">
                      <polyline points="1 4 1 10 7 10"/>
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                    从模型列表生成
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 模型渠道设置 -->
        <section v-if="activeTab === 'model-channels'" class="settings-section settings-embed model-channels-embed">
          <ModelChannels :showBack="false" />
        </section>

        <!-- 项目设置 -->
        <section v-if="activeTab === 'workspace'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <h3>工作目录</h3>
              <p>配置工作目录与编辑行为</p>
            </div>
            <div class="card-body">
              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">项目路径</label>
                  <p class="setting-hint">默认工作目录</p>
                </div>
                <div class="setting-control">
                  <input
                      v-model="settings.workspace.dir"
                      class="form-input"
                      placeholder="."
                      type="text"
                  />
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-info">
                  <label class="setting-label">编辑模式</label>
                  <p class="setting-hint">手动模式需要审批写入操作</p>
                </div>
                <div class="setting-control">
                  <div class="radio-group">
                    <label :class="{ active: settings.workspace.mode === 'free' }" class="radio-option">
                      <input v-model="settings.workspace.mode" :value="'free'" type="radio"/>
                      <span class="radio-label">
                        <span class="radio-title">自由模式</span>
                        <span class="radio-desc">所有工具直接执行，无需审批</span>
                      </span>
                    </label>
                    <label :class="{ active: settings.workspace.mode === 'approval' }" class="radio-option">
                      <input v-model="settings.workspace.mode" :value="'approval'" type="radio"/>
                      <span class="radio-label">
                        <span class="radio-title">审批模式</span>
                        <span class="radio-desc">非只读工具执行前需用户审批</span>
                      </span>
                    </label>
                    <label :class="{ active: settings.workspace.mode === 'auto' }" class="radio-option">
                      <input v-model="settings.workspace.mode" :value="'auto'" type="radio"/>
                      <span class="radio-label">
                        <span class="radio-title">自动模式</span>
                        <span class="radio-desc">自动批准所有工具调用</span>
                      </span>
                    </label>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        <section v-if="activeTab === 'openapi'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <div class="openapi-header">
                <div>
                  <h3>OpenAPI 接口源</h3>
                  <p>管理 OpenAPI 接口源</p>
                </div>
                <div class="openapi-actions">
                  <button class="btn btn-primary btn-sm" @click="openAdd">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <line x1="12" x2="12" y1="5" y2="19"/>
                      <line x1="5" x2="19" y1="12" y2="12"/>
                    </svg>
                    添加
                  </button>
                  <button :disabled="openapiLoading" class="btn btn-sm" @click="loadOpenApiData">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <path d="M23 4v6h-6"/>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                    刷新
                  </button>
                </div>
              </div>
            </div>
            <div class="card-body">
              <!-- 接口搜索 -->
              <div class="openapi-search">
                <div class="search-row">
                  <input v-model="searchKeyword" class="form-input" placeholder="搜索接口文档（多关键词用空格分隔）"
                         type="text" @keyup.enter="doSearch"/>
                  <button :disabled="searching || !searchKeyword.trim()" class="btn btn-primary btn-sm"
                          @click="doSearch">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" x2="16.65" y1="21" y2="16.65"/>
                    </svg>
                    搜索
                  </button>
                </div>

                <!-- 搜索结果 -->
                <div v-if="searchResult" class="search-result">
                  <div class="result-head">
                    <span>搜索结果</span>
                    <button class="btn-icon-xs" @click="clearSearch">×</button>
                  </div>
                  <div v-if="searching" class="result-loading">搜索中...</div>
                  <div v-else-if="Array.isArray(searchResult) && searchResult.length === 0" class="result-empty">
                    未找到匹配的接口
                  </div>
                  <div v-else-if="typeof searchResult === 'string'" class="result-empty">{{ searchResult }}</div>
                  <div v-else class="result-list">
                    <div v-for="(item, i) in searchResult" :key="i" class="result-item">
                      <div class="ri-head">
                        <code class="ri-name">{{ item.api_name }}</code>
                        <span class="ri-cat">{{ item.category }}</span>
                      </div>
                      <div class="ri-desc">{{ item.description }}</div>
                      <div class="ri-endpoint"><code>{{ item.endpoint }}</code></div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 加载 / 错误 -->
              <div v-if="openapiLoading && openapiSources.length === 0" class="state-box">
                <div class="spinner"></div>
                <p>加载中...</p>
              </div>
              <div v-else-if="openapiError" class="state-box error">
                <p>{{ openapiError }}</p>
                <button class="btn btn-sm" @click="loadOpenApiData">重试</button>
              </div>


            </div>
          </div>
          <!-- 源卡片列表 -->
          <div v-if="openapiSources.length > 0" class="openapi-card-list">
            <div v-for="source in openapiSources" :key="source.docUrl" class="openapi-source-card">
              <div class="card-head">
                <div :class="source.status" class="status-tag">
                  <span class="dot"></span>
                  {{ statusLabel(source.status) }}
                </div>
                <div class="card-actions">
                  <button class="btn-icon-xs" title="编辑" @click="openEdit(source)">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                  <button :disabled="openapiLoading" class="btn-icon-xs" title="刷新" @click="refreshSource(source)">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <path d="M23 4v6h-6"/>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>
                  <button class="btn-icon-xs danger" title="删除" @click="removeSource(source)">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="card-body">
                <div class="info-rows">
                  <div class="row">
                    <span class="label">文档</span>
                    <code class="val">{{ source.docUrl }}</code>
                  </div>
                  <div v-if="source.authType && source.authType !== 'none'" class="row">
                    <span class="label">认证</span>
                    <code class="val">{{ authLabel(source) }}</code>
                  </div>
                  <div v-if="source.headers && Object.keys(source.headers).length" class="row">
                    <span class="label">请求头</span>
                    <code class="val">{{ JSON.stringify(source.headers) }}</code>
                  </div>
                </div>
              </div>
              <div v-if="source.status === 'error' && source.errorMessage" class="card-error">
                <svg fill="none" height="11" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="11">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" x2="9" y1="9" y2="15"/>
                  <line x1="9" x2="15" y1="9" y2="15"/>
                </svg>
                {{ source.errorMessage }}
              </div>
            </div>
          </div>

          <div v-if="openapiSources.length === 0 && !openapiLoading" class="state-box">
            <p style="color:var(--fg-3)">暂无接口源，点击上方「添加」按钮注册一个 OpenAPI 文档</p>
          </div>
        </section>

        <!-- MCP 服务器管理 -->
        <section v-if="activeTab === 'mcp'" class="settings-section">
          <div class="section-card mcp-card">
            <!-- ========== 列表视图 ========== -->
            <template v-if="currentMcpView === 'list'">
              <div class="card-header">
                <div class="mcp-list-header">
                  <div>
                    <h3>MCP 服务器</h3>
                    <p>管理 MCP (Model Context Protocol) 服务器配置与工具权限</p>
                  </div>
                  <button class="btn btn-primary btn-sm" @click="openMcpAdd">
                    <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                      <line x1="12" x2="12" y1="5" y2="19"/>
                      <line x1="5" x2="19" y1="12" y2="12"/>
                    </svg>
                    添加服务器
                  </button>
                </div>
              </div>
              <div class="card-body">
                <!-- ========== 发布 Loopra 内置工具 ========== -->
                <div class="mcp-export-panel">
                  <div class="mcp-export-header">
                    <div>
                      <h4>发布 Loopra 工具</h4>
                      <p>把 Loopra 当前工具作为 MCP Server 提供给 Claude Desktop、Cursor 等客户端</p>
                    </div>
                    <label class="toggle-switch" title="启用或停用 Loopra MCP Server">
                      <input v-model="mcpExport.enabled" type="checkbox"/>
                      <span class="toggle-slider"></span>
                    </label>
                  </div>

                  <div v-if="mcpExportLoading" class="mcp-export-loading">
                    <svg class="animate-spin" fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="16">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    正在读取工具清单...
                  </div>

                  <template v-else>
                    <div class="mcp-export-fields">
                      <div class="mcp-export-field">
                        <label>Server 名称</label>
                        <input v-model="mcpExport.name" class="form-input" maxlength="60" placeholder="loopra"/>
                      </div>
                      <div class="mcp-export-field">
                        <label>Endpoint 路径</label>
                        <input v-model="mcpExport.endpoint" class="form-input" placeholder="/mcp" @input="mcpExportEndpointPreview = mcpExport.endpoint"/>
                      </div>
                      <div class="mcp-export-field">
                        <label>传输方式</label>
                        <select v-model="mcpExport.channel" class="form-input">
                          <option value="streamable">Streamable HTTP（推荐）</option>
                          <option value="streamable_stateless">Streamable HTTP（无状态）</option>
                          <option value="sse">SSE</option>
                        </select>
                      </div>
                    </div>

                    <div class="mcp-export-selection">
                      <div class="mcp-export-selection-head">
                        <div>
                          <label>发布哪些工具</label>
                          <span>{{ mcpExportCheckedCount }} / {{ mcpExportEnabledToolCount }} 个已启用工具</span>
                        </div>
                        <button
                          :disabled="mcpExportRefreshing"
                          class="btn btn-ghost btn-xs"
                          type="button"
                          @click="refreshMcpExportTools"
                        >{{ mcpExportRefreshing ? '刷新中...' : '刷新清单' }}</button>
                        <div class="mcp-export-modes">
                          <button
                            :class="{active: mcpExportSelectionMode === 'all'}"
                            class="mcp-export-mode"
                            type="button"
                            @click="setMcpExportSelectionMode('all')"
                          >全部已启用</button>
                          <button
                            :class="{active: mcpExportSelectionMode === 'selected'}"
                            class="mcp-export-mode"
                            type="button"
                            @click="setMcpExportSelectionMode('selected')"
                          >手动选择</button>
                        </div>
                      </div>

                      <div v-if="mcpExportSelectionMode === 'selected'" class="mcp-export-tools">
                        <div class="mcp-export-tool-actions">
                          <button class="btn btn-ghost btn-xs" type="button" @click="selectMcpExportTools(true)">全选已启用</button>
                          <button class="btn btn-ghost btn-xs" type="button" @click="selectMcpExportTools(false)">清空选择</button>
                        </div>
                        <label
                          v-for="tool in mcpExportTools"
                          :key="tool.name"
                          :class="{disabled: !tool.enabled}"
                          class="mcp-export-tool"
                        >
                          <input
                            :checked="isMcpExportToolSelected(tool)"
                            :disabled="!tool.enabled"
                            type="checkbox"
                            @change="toggleMcpExportTool(tool)"
                          />
                          <span class="mcp-export-tool-name">{{ tool.name }}</span>
                          <span class="mcp-export-tool-description">{{ tool.description || '暂无描述' }}</span>
                          <span class="mcp-export-tool-state">{{ tool.enabled ? (isMcpExportToolSelected(tool) ? '已发布' : '未选择') : '全局禁用' }}</span>
                        </label>
                      </div>
                    </div>

                    <div class="mcp-export-footer">
                      <div v-if="mcpExport.enabled" class="mcp-export-endpoint">
                        连接地址 <code>{{ mcpExportEndpointUrl }}</code>
                      </div>
                      <button
                        :disabled="mcpExportSaving"
                        class="btn btn-primary btn-sm"
                        type="button"
                        @click="saveMcpExport"
                      >{{ mcpExportSaving ? '保存中...' : '保存发布配置' }}</button>
                    </div>
                    <p class="mcp-export-hint">默认关闭；启用后请只在可信网络中暴露此地址。MCP 调用使用当前 Loopra 工作目录执行。</p>
                  </template>
                </div>

                <!-- ========== Cloudflare Quick Tunnel ========== -->
                <div class="mcp-tunnel-panel">
                  <div class="mcp-tunnel-header">
                    <div>
                      <h4>Cloudflare Tunnel 内网穿透</h4>
                      <p>通过 Java 管理 cloudflared，将当前 MCP endpoint 临时发布到公网</p>
                    </div>
                    <span :class="`is-${mcpTunnel.state || 'stopped'}`" class="mcp-tunnel-badge">
                      {{ mcpTunnelStateLabel }}
                    </span>
                  </div>

                  <div v-if="mcpTunnelLoading" class="mcp-tunnel-loading">
                    <svg class="animate-spin" fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="16">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    正在检测 cloudflared...
                  </div>

                  <template v-else>
                    <div v-if="mcpTunnel.error" class="mcp-tunnel-error">
                      {{ mcpTunnel.error }}
                    </div>
                    <div v-if="!mcpTunnel.installed" class="mcp-tunnel-warning">
                      未检测到 cloudflared。请先安装并加入 PATH，或填写下面的可执行文件路径。
                      <a href="https://developers.cloudflare.com/tunnel/downloads/" rel="noreferrer" target="_blank">安装说明</a>
                    </div>
                    <div v-if="!mcpExport.enabled" class="mcp-tunnel-warning">
                      请先启用上面的 Loopra MCP 工具发布配置。
                    </div>

                    <div class="mcp-tunnel-fields">
                      <div class="mcp-tunnel-field">
                        <label>cloudflared 路径（可选）</label>
                        <input
                          v-model="mcpTunnelConfig.executablePath"
                          class="form-input"
                          placeholder="PATH 中的 cloudflared 或完整文件路径"
                        />
                      </div>
                    </div>

                    <div class="mcp-tunnel-footer">
                      <div class="mcp-tunnel-url">
                        <template v-if="mcpTunnel.publicUrl">
                          <span>公网 MCP 地址</span>
                          <code>{{ mcpTunnel.publicUrl }}</code>
                          <button class="btn btn-ghost btn-xs" type="button" @click="copyMcpTunnelUrl">复制</button>
                        </template>
                        <template v-else>
                          <span>本地 MCP 地址</span>
                          <code>{{ mcpTunnel.localUrl || mcpExportEndpointUrl }}</code>
                        </template>
                      </div>
                      <div class="mcp-tunnel-actions">
                        <button
                          :disabled="mcpTunnelSaving"
                          class="btn btn-ghost btn-sm"
                          type="button"
                          @click="saveMcpTunnelConfig"
                        >{{ mcpTunnelSaving ? '保存中...' : '保存路径' }}</button>
                        <button
                          v-if="mcpTunnel.running || ['starting', 'stopping'].includes(mcpTunnel.state)"
                          :disabled="mcpTunnelStopping || mcpTunnel.state === 'stopping'"
                          class="btn btn-danger btn-sm"
                          type="button"
                          @click="stopMcpTunnel"
                        >{{ mcpTunnelStopping || mcpTunnel.state === 'stopping' ? '停止中...' : '停止隧道' }}</button>
                        <button
                          v-else
                          :disabled="mcpTunnelStarting || !mcpExport.enabled || mcpExport.channel === 'sse'"
                          class="btn btn-primary btn-sm"
                          type="button"
                          @click="startMcpTunnel"
                        >{{ mcpTunnelStarting ? '启动中...' : '启动临时隧道' }}</button>
                      </div>
                    </div>
                    <p class="mcp-tunnel-hint">
                      Quick Tunnel 地址临时随机，应用退出后失效；只代理 MCP 路径，不会暴露其它 Loopra 页面。Quick Tunnel 不支持 SSE，请使用 Streamable HTTP。
                    </p>
                  </template>
                </div>

                <!-- 加载中 -->
                <div v-if="mcpLoading" class="mcp-state-box">
                  <svg class="animate-spin" fill="none" height="24" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="24">
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  <p>加载中...</p>
                </div>

                <!-- 空状态 -->
                <div v-else-if="mcpServers.length === 0" class="mcp-state-box">
                  <svg fill="none" height="48" stroke="var(--fg-3)" stroke-width="1.5" viewBox="0 0 24 24" width="48">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                    <line x1="6" y1="6" x2="6.01" y2="6"/>
                    <line x1="6" y1="18" x2="6.01" y2="18"/>
                  </svg>
                  <h4>暂无 MCP 服务器</h4>
                  <p>MCP 服务器可扩展 AI 的工具能力，如文件系统访问、数据库查询、API 调用等</p>
                </div>

                <!-- 服务器列表 -->
                <div v-else class="mcp-server-list">
                  <div
                    v-for="svr in mcpServers"
                    :key="svr.name"
                    class="mcp-server-item"
                    @click="openMcpTools(svr)"
                  >
                    <div class="mcp-item-icon" :class="'type-' + svr.type">
                      {{ typeIcon(svr.type) }}
                    </div>
                    <div class="mcp-item-info">
                      <div class="mcp-item-name">{{ svr.name }}</div>
                      <span class="mcp-type-tag">{{ typeLabel(svr.type) }}</span>
                      <div class="mcp-item-detail">{{ svr.type === 'stdio' ? svr.command : svr.url }}</div>
                    </div>
                    <div class="mcp-item-actions" @click.stop>
                      <button class="btn-icon-xs" title="编辑" @click="openMcpEdit(svr)">
                        <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      <label class="toggle-switch">
                        <input type="checkbox" :checked="svr.enabled" @change="toggleMcpServer(svr)"/>
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- ========== 新增/编辑表单视图 ========== -->
            <template v-if="currentMcpView === 'form'">
              <div class="card-header">
                <div class="mcp-form-header">
                  <button class="btn btn-ghost btn-sm" @click="backToMcpList">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <polyline points="15 18 9 12 15 6"/>
                    </svg>
                    返回
                  </button>
                  <h3>{{ mcpEditName ? '编辑 MCP 服务器' : '新增 MCP 服务器' }}</h3>
                </div>
              </div>
              <div class="card-body">
                <!-- 名称 -->
                <div class="mcp-field">
                  <label>名称 <span class="req">*</span></label>
                  <input
                    id="mcpName"
                    v-model="mcpForm.name"
                    class="form-input"
                    placeholder="my-mcp-server"
                    type="text"
                  />
                  <p class="mcp-hint">仅允许字母、数字、下划线和连字符</p>
                </div>

                <!-- 类型选择 -->
                <div class="mcp-field">
                  <label>类型 <span class="req">*</span></label>
                  <div class="mcp-type-toggle">
                    <button
                      :class="{ active: mcpForm.type === 'stdio' }"
                      class="type-btn"
                      @click="mcpForm.type = 'stdio'"
                    >stdio</button>
                    <button
                      :class="{ active: mcpForm.type === 'sse' }"
                      class="type-btn"
                      @click="mcpForm.type = 'sse'"
                    >http sse</button>
                    <button
                      :class="{ active: mcpForm.type === 'streamable' }"
                      class="type-btn"
                      @click="mcpForm.type = 'streamable'"
                    >http streamable</button>
                  </div>
                </div>

                <!-- stdio 配置 -->
                <template v-if="mcpForm.type === 'stdio'">
                  <div class="mcp-field">
                    <label>命令 <span class="req">*</span></label>
                    <input
                      id="mcpCommand"
                      v-model="mcpForm.command"
                      class="form-input"
                      placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                      type="text"
                    />
                  </div>
                  <div class="mcp-field">
                    <label>参数（可选）</label>
                    <textarea
                      id="mcpArgs"
                      v-model="mcpForm.argsText"
                      class="form-textarea"
                      placeholder="/path/to/dir
--option value"
                      rows="3"
                    ></textarea>
                    <p class="mcp-hint">每行一个参数</p>
                  </div>
                  <div class="mcp-field">
                    <label>环境变量（可选）</label>
                    <textarea
                      id="mcpEnv"
                      v-model="mcpForm.envText"
                      class="form-textarea"
                      placeholder="API_KEY=xxx
DEBUG=true"
                      rows="3"
                    ></textarea>
                    <p class="mcp-hint">每行一个 KEY=VALUE</p>
                  </div>
                </template>

                <!-- 远程配置 -->
                <template v-if="mcpForm.type === 'sse' || mcpForm.type === 'streamable'">
                  <div class="mcp-field">
                    <label>URL <span class="req">*</span></label>
                    <input
                      id="mcpRemoteUrl"
                      v-model="mcpForm.url"
                      class="form-input"
                      placeholder="http://localhost:3001/sse"
                      type="text"
                    />
                    <p class="mcp-hint">必须以 http:// 或 https:// 开头</p>
                  </div>
                  <div class="mcp-field">
                    <label>请求头（可选）</label>
                    <textarea
                      id="mcpHeaders"
                      v-model="mcpForm.headersText"
                      class="form-textarea"
                      placeholder="Authorization=Bearer xxx
X-Custom-Header=value"
                      rows="3"
                    ></textarea>
                    <p class="mcp-hint">每行一个 KEY=VALUE</p>
                  </div>
                  <div class="mcp-field">
                    <label>超时时间（可选）</label>
                    <input
                      id="mcpTimeout"
                      v-model="mcpForm.timeout"
                      class="form-input"
                      placeholder="30s"
                      style="width:120px"
                      type="text"
                    />
                  </div>
                </template>

                <!-- 连接检测 -->
                <div class="mcp-field">
                  <button
                    id="mcpCheckBtn"
                    :disabled="mcpChecking || !mcpFormValid"
                    class="btn btn-secondary"
                    @click="checkMcpConnection"
                  >
                    <svg v-if="mcpChecking" class="animate-spin" fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    <svg v-else fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                      <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    {{ mcpChecking ? '检测中...' : '检测连接' }}
                  </button>
                  <div v-if="mcpCheckResult" class="mcp-check-result" :class="mcpCheckResult.ok ? 'ok' : 'error'">
                    <svg v-if="mcpCheckResult.ok" fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                      <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    <svg v-else fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="15" x2="9" y1="9" y2="15"/>
                      <line x1="9" x2="15" y1="9" y2="15"/>
                    </svg>
                    <span>{{ mcpCheckResult.message }}</span>
                  </div>
                </div>

                <!-- 操作按钮 -->
                <div class="mcp-form-actions">
                  <button class="btn" @click="backToMcpList">取消</button>
                  <button
                    v-if="mcpEditName"
                    class="btn btn-secondary"
                    @click="copyMcpServer"
                  >复制</button>
                  <button
                    v-if="mcpEditName"
                    class="btn btn-danger"
                    @click="deleteMcpServer(mcpEditName)"
                  >删除</button>
                  <button
                    :disabled="mcpSaving || !mcpFormValid"
                    class="btn btn-primary"
                    @click="saveMcpServer"
                  >{{ mcpSaving ? '保存中...' : '保存' }}</button>
                </div>
              </div>
            </template>

            <!-- ========== 工具列表视图 ========== -->
            <template v-if="currentMcpView === 'tools'">
              <div class="card-header">
                <div class="mcp-tools-header">
                  <button class="btn btn-ghost btn-sm" @click="backToMcpList">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <polyline points="15 18 9 12 15 6"/>
                    </svg>
                    返回
                  </button>
                  <h3>{{ mcpToolsServerName }} - 工具列表</h3>
                </div>
              </div>
              <div class="card-body">
                <!-- 加载中 -->
                <div v-if="mcpToolsLoading" class="mcp-state-box">
                  <svg class="animate-spin" fill="none" height="24" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="24">
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  <p>加载中...</p>
                </div>

                <!-- 服务器未连接 -->
                <div v-else-if="!mcpToolsConnected" class="mcp-state-box">
                  <svg fill="none" height="40" stroke="var(--red)" stroke-width="1.5" viewBox="0 0 24 24" width="40">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="15" x2="9" y1="9" y2="15"/>
                    <line x1="9" x2="15" y1="9" y2="15"/>
                  </svg>
                  <h4>服务器未连接</h4>
                  <p>请先启用并确保该 MCP 服务器可正常连接</p>
                </div>

                <!-- 无工具 -->
                <div v-else-if="mcpTools.length === 0" class="mcp-state-box">
                  <svg fill="none" height="40" stroke="var(--fg-3)" stroke-width="1.5" viewBox="0 0 24 24" width="40">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" x2="8" y1="13" y2="13"/>
                    <line x1="16" x2="8" y1="17" y2="17"/>
                  </svg>
                  <h4>暂无工具</h4>
                  <p>该 MCP 服务器未提供任何工具</p>
                </div>

                <!-- 工具列表 -->
                <template v-else>
                  <!-- 工具栏 -->
                  <div id="mcpToolsToolbar" class="mcp-tools-toolbar">
                    <label class="mcp-checkbox-label">
                      <input
                        :checked="mcpAllToolsChecked"
                        class="mcp-checkbox"
                        type="checkbox"
                        @change="toggleAllMcpTools"
                      />
                      <span class="mcp-checkbox-custom"></span>
                      全选
                    </label>
                    <span class="mcp-tools-count">{{ mcpEnabledCount }} / {{ mcpTools.length }} 已启用</span>
                    <button
                      :disabled="mcpToolsSaving"
                      class="btn btn-primary btn-sm"
                      @click="saveMcpTools"
                    >{{ mcpToolsSaving ? '保存中...' : '保存' }}</button>
                  </div>

                  <!-- 工具列表项 -->
                  <div class="mcp-tools-list">
                    <div
                      v-for="tool in mcpTools"
                      :key="tool.name"
                      class="mcp-tool-item"
                    >
                      <label class="mcp-checkbox-label">
                        <input
                          :checked="!mcpDisallowedSet.has(tool.name)"
                          class="mcp-checkbox"
                          type="checkbox"
                          @change="toggleMcpTool(tool.name)"
                        />
                        <span class="mcp-checkbox-custom"></span>
                      </label>
                      <div class="mcp-tool-icon">T</div>
                      <div class="mcp-tool-info">
                        <div class="mcp-tool-name">{{ tool.name }}</div>
                        <div v-if="tool.description" class="mcp-tool-desc">{{ tool.description }}</div>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </section>

        <!-- LSP 服务器管理 -->
        <section v-if="activeTab === 'lsp'" class="settings-section">
          <div class="section-card mcp-card">
            <!-- 列表视图 -->
            <template v-if="currentLspView === 'list'">
              <div class="card-header">
                <div class="mcp-list-header">
                  <div>
                    <h3>LSP 服务器</h3>
                    <p>配置语言服务器 (Language Server Protocol) 用于代码智能分析</p>
                  </div>
                  <div style="display:flex;align-items:center;gap:12px;">
                    <label class="toggle-switch" :class="{disabled: lspFullDisableSaving}" title="完全禁用 LSP 功能，将 lsp 加入已禁用工具列表">
                      <input type="checkbox" :checked="lspFullyDisabled" @change="toggleLspFullDisable" :disabled="lspFullDisableSaving"/>
                      <span class="toggle-slider"></span>
                    </label>
                    <span v-if="lspFullDisableSaving" style="font-size:12px;color:var(--fg-3);white-space:nowrap;">保存中...</span>
                    <span v-else style="font-size:12px;color:var(--fg-3);white-space:nowrap;">完全禁用</span>
                    <button class="btn btn-primary btn-sm" @click="openLspAdd" :disabled="lspFullyDisabled">
                      <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                        <line x1="12" x2="12" y1="5" y2="19"/>
                        <line x1="5" x2="19" y1="12" y2="12"/>
                      </svg>
                      添加服务器
                    </button>
                  </div>
                </div>
              </div>
              <div class="card-body">
                <div v-if="lspFullyDisabled" class="mcp-state-box" style="background:var(--yellow-1, #fefce8);border:1px solid var(--yellow-5, #eab308);border-radius:8px;padding:12px 16px;margin-bottom:12px;">
                  <svg fill="none" height="20" stroke="var(--yellow-5, #eab308)" stroke-width="2" viewBox="0 0 24 24" width="20">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" x2="12" y1="9" y2="13"/>
                    <line x1="12" x2="12.01" y1="17" y2="17"/>
                  </svg>
                  <p style="margin:0;font-size:13px;color:var(--yellow-8, #854d0e);">LSP 已被完全禁用，所有语言服务器将不会启动。在左下角「工具」弹窗或工具箱中启用 "lsp" 即可恢复。</p>
                </div>
                <div v-if="lspLoading" class="mcp-state-box">
                  <svg class="animate-spin" fill="none" height="24" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="24">
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  <p>加载中...</p>
                </div>
                <div v-else-if="lspServers.length === 0" class="mcp-state-box">
                  <svg fill="none" height="48" stroke="var(--fg-3)" stroke-width="1.5" viewBox="0 0 24 24" width="48">
                    <polyline points="16 18 22 12 16 6"/>
                    <polyline points="8 6 2 12 8 18"/>
                  </svg>
                  <h4>暂无 LSP 服务器</h4>
                  <p>LSP 服务器可为 AI 提供代码理解能力——定义跳转、引用查找、悬停提示、文档符号等</p>
                </div>
                <div v-else class="mcp-server-list">
                  <div v-for="svr in lspServers" :key="svr.name" class="mcp-server-item">
                    <div class="mcp-item-icon">L</div>
                    <div class="mcp-item-info">
                      <div class="mcp-item-name">
                        {{ svr.name }}
                        <span v-if="svr.installed" class="mcp-type-tag" style="background:#e6f7e6;color:#389e0d;margin-left:4px">已安装</span>
                      </div>
                      <div class="mcp-item-detail">{{ typeof svr.command === 'string' ? svr.command : (svr.command || []).join(' ') }}</div>
                      <div class="mcp-item-detail" style="font-size:11px;color:var(--fg-3);margin-top:2px">{{ (svr.extensions || []).join(', ') }}</div>
                    </div>
                    <div class="mcp-item-actions" @click.stop>
                      <button class="btn-icon-xs" title="编辑" @click="openLspEdit(svr)" :disabled="lspFullyDisabled">
                        <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </button>
                      <label class="toggle-switch" :class="{disabled: lspFullyDisabled}" :title="lspFullyDisabled ? 'LSP 已被完全禁用' : ''">
                        <input type="checkbox" :checked="svr.enabled" @change="toggleLspServer(svr)" :disabled="lspFullyDisabled"/>
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- 表单视图 -->
            <template v-if="currentLspView === 'form'">
              <div class="card-header">
                <div class="mcp-form-header">
                  <button class="btn btn-ghost btn-sm" @click="backToLspList">
                    <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
                      <polyline points="15 18 9 12 15 6"/>
                    </svg>
                    返回
                  </button>
                  <h3>{{ lspEditName ? '编辑 LSP 服务器' : '新增 LSP 服务器' }}</h3>
                </div>
              </div>
              <div class="card-body">
                <div class="mcp-field">
                  <label>名称 <span class="req">*</span></label>
                  <input v-model="lspForm.name" class="form-input" placeholder="my-lsp-server" type="text" :readonly="!!lspEditName"/>
                  <p class="mcp-hint">仅允许字母、数字、下划线和连字符{{ lspEditName ? '（编辑时不可修改）' : '' }}</p>
                </div>
                <div class="mcp-field">
                  <label>启动命令 <span class="req">*</span></label>
                  <input v-model="lspForm.command" class="form-input" placeholder="typescript-language-server --stdio" type="text"/>
                </div>
                <div class="mcp-field">
                  <label>关联扩展名（可选）</label>
                  <input v-model="lspForm.extensionsText" class="form-input" placeholder=".ts, .tsx, .js, .jsx" type="text"/>
                  <p class="mcp-hint">逗号分隔，用于自动匹配文件到 Language Server</p>
                </div>
                <div class="mcp-field">
                  <label>环境变量（可选）</label>
                  <textarea v-model="lspForm.envText" class="form-textarea" placeholder="NODE_PATH=/usr/local/lib/node_modules" rows="3"></textarea>
                  <p class="mcp-hint">每行一个 KEY=VALUE</p>
                </div>
                <div class="mcp-form-actions">
                  <button class="btn" @click="backToLspList">取消</button>
                  <button v-if="lspEditName" class="btn btn-danger" @click="deleteLspServer(lspEditName)">删除</button>
                  <button :disabled="lspSaving || !lspFormValid" class="btn btn-primary" @click="saveLspServer">{{ lspSaving ? '保存中...' : '保存' }}</button>
                </div>
              </div>
            </template>
          </div>
        </section>

        <!-- ==================== 技能市场 ==================== -->
        <section v-if="activeTab === 'skill-market'" class="settings-section">
          <div class="section-card">
            <div class="card-header">
              <h3>技能市场</h3>
              <p>从社区浏览、搜索和安装技能</p>
            </div>
            <div class="card-body">
              <!-- 已安装技能 -->
              <div class="installed-skills-section">
                <div class="installed-skills-header">
                  <div class="installed-skills-toggle" @click="installedSkillsCollapsed = !installedSkillsCollapsed">
                    <svg
                      class="installed-skills-chevron"
                      :class="{ collapsed: installedSkillsCollapsed }"
                      fill="none"
                      height="12"
                      stroke="currentColor"
                      stroke-width="2"
                      viewBox="0 0 24 24"
                      width="12"
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                    <span class="installed-skills-title">已安装技能</span>
                    <span v-if="installedSkillList.length > 0" class="installed-skills-count">{{ installedSkillList.length }}</span>
                    <span class="installed-skills-sub">本机技能池 ~/.loopra/skills 中的技能，卸载后立即生效</span>
                  </div>
                  <button
                    class="btn btn-ghost btn-sm"
                    :disabled="installedSkillsLoading"
                    @click="loadInstalledSkills"
                    title="刷新已安装技能"
                  >
                    <svg v-if="installedSkillsLoading" class="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 12a9 9 0 11-6.219-8.56"/>
                    </svg>
                    <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="23 4 23 10 17 10"/>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                    刷新
                  </button>
                </div>

                <div v-if="!installedSkillsCollapsed">
                <!-- 已安装技能列表 -->
                <div v-if="installedSkillList.length === 0" class="installed-skills-empty">
                  <svg fill="none" height="28" stroke="var(--fg-3)" stroke-width="1.5" viewBox="0 0 24 24" width="28">
                    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>
                  </svg>
                  <p>还没有安装任何技能</p>
                  <p class="hint">从下方市场选择技能并点击「安装」，或手动放入 ~/.loopra/skills/ 目录</p>
                </div>
                <div v-else class="skill-list">
                  <div
                    v-for="skill in installedSkillList"
                    :key="skill.directoryName || skill.name"
                    class="skill-item"
                  >
                    <div class="skill-icon">{{ (skill.name || 'SK').substring(0, 2).toUpperCase() }}</div>
                    <div class="skill-info">
                      <div class="skill-name">
                        {{ skill.name }}
                        <span v-if="skill.directoryName && skill.directoryName !== skill.name" class="skill-installed-badge">{{ skill.directoryName }}</span>
                      </div>
                      <div v-if="skill.description" class="skill-desc">{{ skill.description.length > 80 ? skill.description.substring(0, 80) + '...' : skill.description }}</div>
                    </div>
                    <div class="skill-actions">
                      <button
                        class="btn btn-ghost btn-sm"
                        :disabled="skillMarket.installing === (skill.directoryName || skill.name)"
                        @click="uninstallInstalledSkill(skill)"
                        title="卸载"
                      >
                        <svg v-if="skillMarket.installing === (skill.directoryName || skill.name)" class="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 12a9 9 0 11-6.219-8.56"/>
                        </svg>
                        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        {{ skillMarket.installing === (skill.directoryName || skill.name) ? '卸载中...' : '卸载' }}
                      </button>
                    </div>
                  </div>
                </div>
                </div>
              </div>

              <!-- 工具栏 -->
              <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
                <!-- 市场选择 -->
                <select v-model="skillMarket.currentMarket" @change="loadSkillItems" class="form-select" style="width:160px">
                  <option v-for="m in skillMarket.markets" :key="m.name" :value="m.name">{{ m.name }}</option>
                </select>
                <!-- 搜索框 -->
                <div class="input-group" style="flex:1">
                  <input
                    v-model="skillMarket.searchQuery"
                    class="form-input"
                    placeholder="搜索技能..."
                    type="text"
                    @keyup.enter="searchSkills"
                  />
                  <button class="btn btn-secondary" @click="searchSkills">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </button>
                </div>
                <!-- 刷新 -->
                <button class="btn btn-secondary" :disabled="skillMarket.loading" @click="loadSkillItems">
                  <svg :class="{ 'animate-spin': skillMarket.loading }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                </button>
              </div>

              <!-- 加载状态 -->
              <div v-if="skillMarket.loading" class="state-box">
                <svg class="animate-spin" fill="none" height="24" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="24">
                  <path d="M21 12a9 9 0 11-6.219-8.56"/>
                </svg>
                <p>加载中...</p>
              </div>

              <!-- 错误状态 -->
              <div v-else-if="skillMarket.error" class="state-box" style="color:var(--red)">
                <svg fill="none" height="32" stroke="var(--red)" stroke-width="1.5" viewBox="0 0 24 24" width="32">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <p>{{ skillMarket.error }}</p>
              </div>

              <!-- 空状态 -->
              <div v-else-if="skillMarket.items.length === 0" class="state-box">
                <svg fill="none" height="32" stroke="var(--fg-3)" stroke-width="1.5" viewBox="0 0 24 24" width="32">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                <p>暂无结果</p>
              </div>

              <!-- 技能列表 -->
              <div v-else class="skill-list">
                <div
                  v-for="item in skillMarket.items"
                  :key="item.slug || item.name"
                  class="skill-item"
                >
                  <div class="skill-icon">{{ (item.displayName || item.name || 'SK').substring(0, 2).toUpperCase() }}</div>
                  <div class="skill-info">
                    <div class="skill-name">
                      {{ item.displayName || item.name }}
                      <span v-if="isSkillInstalled(item.slug || item.name)" class="skill-installed-badge">已安装</span>
                    </div>
                    <div v-if="item.summary || item.description" class="skill-desc">{{ (item.summary || item.description).length > 80 ? (item.summary || item.description).substring(0, 80) + '...' : (item.summary || item.description) }}</div>
                    <div class="skill-meta">
                      <span v-if="item.installs > 0">{{ item.installs >= 1000 ? (item.installs / 1000).toFixed(1) + 'k' : item.installs }} 安装</span>
                      <span v-if="item.stars > 0">⭐ {{ item.stars >= 1000 ? (item.stars / 1000).toFixed(1) + 'k' : item.stars }}</span>
                      <span v-if="item.ownerHandle">{{ item.ownerHandle }}</span>
                    </div>
                  </div>
                  <div class="skill-actions">
                    <button
                      v-if="!isSkillInstalled(item.slug || item.name)"
                      class="btn btn-primary btn-sm"
                      :disabled="skillMarket.installing === (item.slug || item.name)"
                      @click="installSkill(item.slug || item.name, item.displayName)"
                    >
                      <svg v-if="skillMarket.installing === (item.slug || item.name)" class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 11-6.219-8.56"/>
                      </svg>
                      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      {{ skillMarket.installing === (item.slug || item.name) ? '安装中...' : '安装' }}
                    </button>
                    <button
                      v-else
                      class="btn btn-ghost btn-sm"
                      :disabled="skillMarket.installing === (item.slug || item.name)"
                      @click="uninstallSkill(item.slug || item.name, item.displayName)"
                      title="卸载"
                    >
                      <svg v-if="skillMarket.installing === (item.slug || item.name)" class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 11-6.219-8.56"/>
                      </svg>
                      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                      </svg>
                      {{ skillMarket.installing === (item.slug || item.name) ? '卸载中...' : '卸载' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ==================== 系统提示词 ==================== -->
        <section v-if="activeTab === 'prompt'" class="settings-section">
          <div class="section-card" style="display:flex;flex-direction:column;height:100%">
            <div class="card-header">
              <h3>系统提示词</h3>
              <p>编辑 ~/.loopra/loopra.md — 保存后自动重新初始化 Agent，新会话将生效</p>
            </div>
            <div class="card-body" style="flex:1;display:flex;flex-direction:column;padding:0;overflow:hidden">
              <div v-if="promptLoading" class="state-box" style="flex:1">
                <svg class="animate-spin" fill="none" height="24" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="24">
                  <path d="M21 12a9 9 0 11-6.219-8.56"/>
                </svg>
                <p>加载中...</p>
              </div>
              <div v-else style="flex:1;display:flex;flex-direction:column;padding:12px;gap:8px;overflow:hidden">
                <div style="flex:1;position:relative;overflow:hidden;border:1px solid var(--border);border-radius:var(--r)">
                  <textarea
                    v-model="promptContent"
                    class="prompt-editor"
                    placeholder="在此输入系统提示词内容（Markdown 格式）…"
                    spellcheck="false"
                  ></textarea>
                </div>
                <div class="prompt-toolbar">
                  <span class="prompt-info">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="16" x2="12" y2="12"/>
                      <line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    {{ promptContent.length }} 字符
                  </span>
                  <div style="display:flex;gap:8px">
                    <button class="btn" @click="loadLoopraMd" :disabled="promptSaving">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="1 4 1 10 7 10"/>
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                      </svg>
                      刷新
                    </button>
                    <button class="btn btn-primary" :disabled="promptSaving" @click="saveLoopraMd">
                      <svg v-if="promptSaving" class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 11-6.219-8.56"/>
                      </svg>
                      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                        <polyline points="17 21 17 13 7 13 7 21"/>
                        <polyline points="7 3 7 8 15 8"/>
                      </svg>
                      {{ promptSaving ? '保存中...' : '保存' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ==================== 关于 ==================== -->
        <section v-if="activeTab === 'about'" class="settings-section">
          <div class="section-card">
            <div class="card-body">
              <VersionInfoPanel
                  :app-version="aboutInfo.version"
                  :electron-version="electronVersion"
                  :latest-version="aboutInfo.latestVersion"
                  :release-url="aboutInfo.releaseUrl"
                  :has-new-version="aboutInfo.hasNewVersion"
                  :desktop-has-new-version="desktopInfo.hasNewVersion"
                  :checking="aboutChecking"
                  :is-electron="platform.isElectron"
                  :auto-updating="autoUpdating"
                  :update-source="updateSource"
                  @check="handleCheckVersion"
                  @download="openDesktopDownload"
                  @core-update="handleCoreUpdateFromPanel"
                  @desktop-update="openDesktopDownload"
                  @auto-update="handleAutoUpdateFromPanel"
              />
              <div v-if="aboutError" class="about-error">{{ aboutError }}</div>
            </div>
          </div>
        </section>

        <!-- ==================== 工具 ==================== -->
        <section v-if="activeTab === 'tools'" class="settings-section settings-embed">
          <ToolsView class="settings-embed-view" />
        </section>

        <!-- ==================== 子代理 ==================== -->
        <section v-else-if="activeTab === 'sub-agents'" class="settings-section settings-embed">
          <SubAgentsView class="settings-embed-view" />
        </section>

        <!-- ==================== 数据面板 ==================== -->
        <section v-else-if="activeTab === 'dashboard'" class="settings-section settings-embed">
          <DashboardPanel class="settings-embed-view" />
        </section>

      </div>
    </main>
  </div>

  <!-- 添加/编辑对话框 -->
  <Teleport to="body">
    <div v-if="showAddDialog" class="add-mask" @click.self="showAddDialog = false">
      <div class="add-dialog">
        <div class="add-head">
          <span>{{ editingSource ? '编辑 OpenAPI 接口源' : '添加 OpenAPI 接口源' }}</span>
          <button class="btn-icon-xs" @click="showAddDialog = false">×</button>
        </div>
        <div class="add-body">
          <div class="field">
            <label>文档地址 <span class="req">*</span></label>
            <input v-model="form.docUrl" class="form-input" placeholder="https://petstore.swagger.io/v2/swagger.json"
                   type="text"/>
            <p class="hint">支持 http://、https:// 和 classpath: 开头</p>
          </div>
          <div class="field">
            <label>请求头（可选）</label>
            <div class="header-list">
              <div v-for="(h, i) in form.headerList" :key="i" class="header-row">
                <input v-model="h.key" class="form-input" placeholder="名称" type="text"/>
                <input v-model="h.value" class="form-input" placeholder="值" type="text"/>
                <button class="btn-icon-xs" @click="form.headerList.splice(i, 1)">×</button>
              </div>
              <button class="btn btn-text btn-sm" @click="form.headerList.push({ key: '', value: '' })">+ 添加请求头
              </button>
            </div>
          </div>

          <!-- 认证方式 -->
          <div class="field">
            <label>认证方式</label>
            <div class="auth-tabs">
              <button :class="{ active: form.authType === 'none' }" class="auth-tab" @click="form.authType = 'none'">
                无
              </button>
              <button :class="{ active: form.authType === 'bearer' }" class="auth-tab"
                      @click="form.authType = 'bearer'">Bearer Token
              </button>
              <button :class="{ active: form.authType === 'apikey' }" class="auth-tab"
                      @click="form.authType = 'apikey'">API Key
              </button>
              <button :class="{ active: form.authType === 'basic' }" class="auth-tab" @click="form.authType = 'basic'">
                用户名/密码
              </button>
            </div>
          </div>

          <div v-if="form.authType === 'bearer'" class="field">
            <label>Token <span class="req">*</span></label>
            <input v-model="form.bearerToken" class="form-input" placeholder="sk-xxxxxx" type="text"/>
          </div>

          <div v-if="form.authType === 'apikey'" class="field">
            <label>Header 名称 <span class="req">*</span></label>
            <input v-model="form.apiKeyName" class="form-input" placeholder="X-API-Key" type="text"/>
            <label style="margin-top:8px">Header 值 <span class="req">*</span></label>
            <input v-model="form.apiKeyValue" class="form-input" placeholder="your-api-key" type="text"/>
          </div>

          <div v-if="form.authType === 'basic'" class="field">
            <label>用户名 <span class="req">*</span></label>
            <input v-model="form.basicUser" class="form-input" placeholder="admin" type="text"/>
            <label style="margin-top:8px">密码 <span class="req">*</span></label>
            <input v-model="form.basicPass" class="form-input" placeholder="password" type="password"/>
          </div>
        </div>
        <div class="add-foot">
          <button class="btn" @click="showAddDialog = false">取消</button>
          <button :disabled="openapiSubmitting" class="btn btn-primary" @click="submitAdd">
            {{ openapiSubmitting ? '提交中...' : (editingSource ? '保存' : '添加') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 远端模型选择弹窗 -->
  <Teleport to="body">
    <div v-if="showRemoteModelsDialog" class="remote-models-mask" @click.self="showRemoteModelsDialog = false">
      <div class="remote-models-dialog">
        <div class="remote-models-head">
          <span>远端模型列表</span>
          <span class="remote-models-count">{{ remoteModelList.length }} 个模型</span>
          <button class="btn-icon-xs" @click="showRemoteModelsDialog = false">×</button>
        </div>
        <div class="remote-models-body">
          <div v-if="remoteModelsLoading" class="remote-models-loading">
            <span class="loading-dot"></span> 正在获取远端模型...
          </div>
          <div v-else-if="remoteModelList.length === 0" class="remote-models-empty">
            暂无可用模型
          </div>
          <template v-else>
            <div class="remote-models-toolbar">
              <label class="remote-check-all">
                <input
                    type="checkbox"
                    :checked="selectedRemoteModels.size === remoteModelList.length"
                    :indeterminate="selectedRemoteModels.size > 0 && selectedRemoteModels.size < remoteModelList.length"
                    @change="toggleSelectAll"
                />
                <span>全选 / 取消</span>
              </label>
              <span class="remote-selected-count">已选 {{ selectedRemoteModels.size }} 项</span>
              <input
                  v-model="remoteSearchQuery"
                  class="form-input"
                  placeholder="搜索模型..."
                  style="width:200px;"
              />
            </div>
            <div class="remote-models-list">
              <div
                  v-for="m in filteredRemoteModelList"
                  :key="m"
                  class="remote-model-item"
                  :class="{ checked: selectedRemoteModels.has(m) }"
                  @click="toggleModel(m)"
              >
                <input type="checkbox" :checked="selectedRemoteModels.has(m)" />
                <span class="remote-model-name">{{ m }}</span>
                <span v-if="m === settings.ai.model" class="remote-model-badge">当前</span>
              </div>
            </div>
          </template>
        </div>
        <div class="remote-models-foot">
          <button class="btn" @click="showRemoteModelsDialog = false">取消</button>
          <button
              :disabled="selectedRemoteModels.size === 0"
              class="btn btn-primary"
              @click="confirmRemoteModels"
          >
            确认填入 ({{ selectedRemoteModels.size }})
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 自动填入配置弹窗 -->
  <Teleport to="body">
    <div v-if="showAutoFillDialog" class="auto-fill-mask" @click.self="showAutoFillDialog = false">
      <div class="auto-fill-dialog">
        <div class="auto-fill-head">
          <span>AI模型自动填入</span>
          <button class="btn-icon-xs" @click="showAutoFillDialog = false">×</button>
        </div>
        <div class="auto-fill-body">
          <div class="auto-fill-field">
            <label class="auto-fill-label">选择服务商</label>
            <div class="select-wrapper">
              <select v-model="autoFillPreset" class="form-select" @change="onPresetChange">
                <option value="">自定义地址</option>
                <option value="https://api.siliconflow.cn/v1">SiliconFlow</option>
                <option value="https://api.deepseek.com">DeepSeek</option>
                <option value="https://api.xiaomimimo.com/v1">小米</option>
                <option value="https://token-plan-cn.xiaomimimo.com/v1">小米TokenPlan</option>
                <option value="https://openrouter.ai/api/v1">OpenRouter</option>
                <option value="https://opencode.ai/zen/go/v1">OpenCode Go</option>
              </select>
              <svg class="select-arrow" fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
          </div>
          <div class="auto-fill-field">
            <label class="auto-fill-label">API 地址</label>
            <input v-model="autoFillUrl" class="form-input" placeholder="https://api.openai.com/v1" type="text" />
          </div>
          <div class="auto-fill-field">
            <label class="auto-fill-label">API 密钥</label>
            <input v-model="autoFillApiKey" class="form-input" placeholder="sk-..." type="password" autocomplete="new-password" />
          </div>
        </div>
        <div class="auto-fill-foot">
          <button class="btn" @click="showAutoFillDialog = false">取消</button>
          <button
              :disabled="!autoFillUrl || !autoFillApiKey"
              class="btn btn-primary"
              @click="confirmAutoFill"
          >
            自动填入
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 添加模型价格弹窗 -->
  <Teleport to="body">
    <div v-if="showAddPriceDialog" class="auto-fill-mask" @click.self="showAddPriceDialog = false">
      <div class="auto-fill-dialog">
        <div class="auto-fill-head">
          <span>添加模型价格</span>
          <button class="btn-icon-xs" @click="showAddPriceDialog = false">×</button>
        </div>
        <div class="auto-fill-body">
          <div class="auto-fill-field">
            <label class="auto-fill-label">模型名称</label>
            <input
              v-model="newPriceModelName"
              class="form-input"
              placeholder="例如: gpt-4"
              type="text"
              @keyup.enter="confirmAddPrice"
            />
          </div>
        </div>
        <div class="auto-fill-foot">
          <button class="btn" @click="showAddPriceDialog = false">取消</button>
          <button
            :disabled="!newPriceModelName.trim()"
            class="btn btn-primary"
            @click="confirmAddPrice"
          >
            确认添加
          </button>
        </div>
      </div>
    </div>
  </Teleport>

</template>

<script setup>
import {computed, defineAsyncComponent, h, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import {message, Modal} from 'ant-design-vue'
import {useAppStore} from '../stores/app'
import {
  agentAPI,
  configAPI,
  DEFAULT_API_BASE,
  extpackAPI,
  lspAPI,
  mcpAPI,
  openApiAPI,
  petAPI,
  pluginAPI,
  skillMarketAPI,
  systemAPI
} from '../services/api'
import {md} from '../utils/highlight'
import {RELEASE_LATEST_URL} from '../utils/constants'
import {loadUpdateSource} from '../utils/updateScripts'
import platform from '../services/platform'
import VersionInfoPanel from '../components/VersionInfoPanel.vue'
import PetSprite from '../components/PetSprite.vue'
import ModelChannels from '../ModelChannels.vue'
// 工具/子代理/数据面板按需异步加载（切到对应 tab 时才拉取组件块，避免拖慢设置页打开）
const EmbedLoading = {
  render: () => h('div', {class: 'settings-embed-loading'}, '加载中…')
}
const ToolsView = defineAsyncComponent({
  loader: () => import('./Tools.vue'),
  loadingComponent: EmbedLoading
})
const SubAgentsView = defineAsyncComponent({
  loader: () => import('./SubAgents.vue'),
  loadingComponent: EmbedLoading
})
const DashboardPanel = defineAsyncComponent({
  loader: () => import('../components/Dashboard.vue'),
  loadingComponent: EmbedLoading
})

const store = useAppStore()
const props = defineProps({
  initialTab: {type: String, default: 'general'},
  marketOnly: {type: Boolean, default: false}
})

const plugins = ref([])
const pluginsLoading = ref(false)
const pluginToggling = ref(null)

const loadPlugins = async () => {
  pluginsLoading.value = true
  try {
    const response = await pluginAPI.list()
    plugins.value = response.success && Array.isArray(response.data) ? response.data : []
  } catch (error) {
    message.error('加载插件失败: ' + (error.message || error))
  } finally {
    pluginsLoading.value = false
  }
}

const togglePlugin = async (plugin, enabled) => {
  pluginToggling.value = plugin.id
  try {
    const response = await pluginAPI.setEnabled(plugin.id, enabled)
    if (response.success && response.data) {
      const index = plugins.value.findIndex(item => item.id === plugin.id)
      if (index >= 0) plugins.value[index] = response.data
      message.success(`${plugin.displayName} 已${enabled ? '启用' : '停用'}`)
    }
    await loadPlugins()
  } catch (error) {
    message.error('切换插件失败: ' + (error.message || error))
    await loadPlugins()
  } finally {
    pluginToggling.value = null
  }
}

// 拓展包（Solon H-SPI）
const extPacks = ref([])
const extPacksLoading = ref(false)
const extPackInstalling = ref(false)
const extPackAction = ref(null)
const extPackSource = ref('')

const loadExtPacks = async () => {
  extPacksLoading.value = true
  try {
    const response = await extpackAPI.list()
    extPacks.value = response.success && Array.isArray(response.data) ? response.data : []
  } catch (error) {
    message.error('加载拓展包失败: ' + (error.message || error))
  } finally {
    extPacksLoading.value = false
  }
}

const installExtPack = async () => {
  const source = extPackSource.value.trim()
  if (!source) {
    message.warning('请输入 jar 直链或本地路径')
    return
  }
  extPackInstalling.value = true
  try {
    await extpackAPI.install(source)
    message.success('拓展包安装并启动成功')
    extPackSource.value = ''
    await loadExtPacks()
  } catch (error) {
    message.error('安装失败: ' + (error.message || error))
  } finally {
    extPackInstalling.value = false
  }
}

// 桌面端：弹出系统文件选择器选 jar，选中后直接安装
const chooseExtPackFile = async () => {
  let filePath
  try {
    filePath = await window.electronAPI?.pickJarFile?.()
  } catch (error) {
    message.error('选择文件失败: ' + (error.message || error))
    return
  }
  if (!filePath) return
  extPackSource.value = filePath
  await installExtPack()
}

const toggleExtPack = async (pack, enabled) => {
  extPackAction.value = pack.id
  try {
    await extpackAPI.setEnabled(pack.id, enabled)
    message.success(`拓展包 ${pack.id} 已${enabled ? '启用' : '停用'}`)
    await loadExtPacks()
  } catch (error) {
    message.error('切换失败: ' + (error.message || error))
  } finally {
    extPackAction.value = null
  }
}

const uninstallExtPack = async (pack) => {
  Modal.confirm({
    title: '卸载拓展包',
    content: `确定要卸载「${pack.id}」吗？将停止运行并删除本地 jar 文件。`,
    okText: '卸载',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      extPackAction.value = pack.id
      try {
        await extpackAPI.uninstall(pack.id)
        message.success('拓展包已卸载: ' + pack.id)
        await loadExtPacks()
      } catch (error) {
        message.error('卸载失败: ' + (error.message || error))
      } finally {
        extPackAction.value = null
      }
    }
  })
}

// 主题直接绑定 store
const settings = reactive({
  get theme() {
    return store.settings.theme
  },
  set theme(v) {
    store.settings.theme = v
  },
  get fontFamily() {
    return store.settings.fontFamily
  },
  set fontFamily(v) {
    store.settings.fontFamily = v
  },
  server: {apiBaseUrl: '', autoConnect: true},
  ai: {
    baseUrl: '', apiKey: '', model: '', reasoningEffort: 'max',
    availableModelsText: '', prices: {}
  },
  workspace: {dir: '', mode: 'free'},
  security: {
    stormBreaker: true,
    pathTraversal: true,
    commandWhitelist: true,
    auditLog: true,
    disabledToolsText: ''
  }
})

const reasoningEffortLevels = [
  {value: 'none', label: '无推理', shortLabel: '无', description: '直接响应'},
  {value: 'low', label: '低强度', shortLabel: '低', description: '快速响应'},
  {value: 'medium', label: '平衡', shortLabel: '中', description: '速度与深度兼顾'},
  {value: 'high', label: '高强度', shortLabel: '高', description: '更充分地思考'},
  {value: 'xhigh', label: '超高推理', shortLabel: '超高', description: '接近极限的深度推理'},
  {value: 'max', label: '极致推理', shortLabel: '最大', description: '优先获得最完整的推理'}
]

const reasoningEffortIndex = computed(() => {
  const index = reasoningEffortLevels.findIndex(level => level.value === settings.ai.reasoningEffort)
  return index === -1 ? reasoningEffortLevels.length - 1 : index
})
const selectedReasoningEffort = computed(() => reasoningEffortLevels[reasoningEffortIndex.value])
const reasoningEffortProgress = computed(() => (
  reasoningEffortIndex.value / (reasoningEffortLevels.length - 1)
) * 100)
const setReasoningEffort = (index) => {
  settings.ai.reasoningEffort = reasoningEffortLevels[Number(index)]?.value || 'max'
}

const activeTab = ref(props.marketOnly ? 'skill-market' : (props.initialTab === 'ai' ? 'general' : props.initialTab))
const showApiKey = ref(false)
const loading = ref(false)
const availableModels = ref([])
const checkingConnection = ref(false)
const connectionOk = ref(false)
const connectionChecked = ref(false)
const hasChanges = ref(false)
// 保存原始值，用于检测 baseUrl/apiKey 是否变更（变更需弹警告并重建 Agent）
const originalBaseUrl = ref('')
// apiKey 从服务端返回的是脱敏值，通过 localStorage 持久化最近一次保存的 apiKey 用于对比
const getLastSavedApiKey = () => localStorage.getItem('loopra-last-apikey') || ''
const setLastSavedApiKey = (key) => localStorage.setItem('loopra-last-apikey', key)
const remoteModelsLoading = ref(false)
// 远端模型弹窗状态
const showRemoteModelsDialog = ref(false)
const remoteModelList = ref([])
const selectedRemoteModels = ref(new Set())
const remoteSearchQuery = ref('')

// 系统提示词编辑
const promptContent = ref('')
const promptLoading = ref(false)
const promptSaving = ref(false)

// 宠物设置状态
const petsList = ref([])
const petsLoading = ref(false)
const petsError = ref('')
const activePetName = ref('')
const activePetAnim = ref('idle')
const petIniting = ref(false)
const desktopPetVisible = ref(false)
const isElectron = Boolean(window.electronAPI?.desktopPet)

// 宠物动画列表（循环切换）
const PET_ANIM_NAMES = ['idle', 'waving', 'jumping', 'running-right', 'running-left', 'waiting', 'review']

function cyclePetAnim() {
  const idx = PET_ANIM_NAMES.indexOf(activePetAnim.value)
  activePetAnim.value = PET_ANIM_NAMES[(idx + 1) % PET_ANIM_NAMES.length]
}

async function loadPets() {
  petsLoading.value = true
  petsError.value = ''
  try {
    const [listRes, activeRes] = await Promise.all([
      petAPI.listPets(),
      petAPI.getActive()
    ])
    if (listRes.success && Array.isArray(listRes.data)) {
      petsList.value = listRes.data.map(p => ({
        ...p,
        spritesheetUrl: petAPI.getPetSpritesheetUrl(p.name)
      }))
    } else {
      petsList.value = []
      if (!listRes.success) petsError.value = listRes.error || '加载宠物列表失败'
    }
    if (activeRes.success && activeRes.data && activeRes.data.active) {
      activePetName.value = activeRes.data.name
      store.activePetName = activeRes.data.name
    }
    if (isElectron) {
      desktopPetVisible.value = await window.electronAPI.desktopPet.isVisible()
      store.desktopPetVisible = desktopPetVisible.value
    }
  } catch (err) {
    console.error('加载宠物设置失败:', err)
    petsError.value = err.message || '无法连接服务器'
  } finally {
    petsLoading.value = false
  }
}

async function selectPet(name) {
  if (name === activePetName.value) return // 已激活的不用重复切换
  try {
    const res = await petAPI.setActive(name)
    if (res.success) {
      activePetName.value = name
      store.activePetName = name
      if (desktopPetVisible.value) await window.electronAPI.desktopPet.refresh()
      message.success('已切换到宠物: ' + name)
    } else {
      message.error(res.error || '切换宠物失败')
    }
  } catch (err) {
    message.error('切换宠物失败: ' + (err.message || ''))
  }
}

async function toggleDesktopPet() {
  if (!isElectron || !activePetName.value) return
  if (desktopPetVisible.value) {
    await window.electronAPI.desktopPet.close()
    desktopPetVisible.value = false
    store.desktopPetVisible = false
    return
  }
  await window.electronAPI.desktopPet.open()
  desktopPetVisible.value = true
  store.desktopPetVisible = true
}

// 重置桌面宠物位置到初始位置（主窗口右下角）
async function resetPetPosition() {
  if (!isElectron || !activePetName.value) return
  try {
    const res = await window.electronAPI.desktopPet.resetPosition()
    message.success(`宠物位置已重置到初始位置 (${res?.x}, ${res?.y})`)
  } catch (err) {
    message.error('重置宠物位置失败: ' + (err.message || ''))
  }
}

// web 端：显示/隐藏聊天内宠物（状态持久化，桌面端聊天内不展示宠物）
function toggleWebPet() {
  store.setPetHidden(!store.petHidden)
}

// 删除宠物
async function deletePet(name) {
  Modal.confirm({
    title: '删除宠物',
    content: `确定要删除宠物「${name}」吗？此操作不可恢复。`,
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      try {
        const res = await petAPI.deletePet(name)
        if (res.success) {
          if (activePetName.value === name) {
            activePetName.value = ''
            store.activePetName = ''
            if (desktopPetVisible.value) {
              await window.electronAPI.desktopPet.close()
              desktopPetVisible.value = false
              store.desktopPetVisible = false
            }
          }
          message.success('宠物已删除: ' + name)
          await loadPets()
        } else {
          message.error(res.error || '删除宠物失败')
        }
      } catch (err) {
        message.error('删除宠物失败: ' + (err.message || ''))
      }
    }
  })
}

// 初始化宠物：转发给父组件（App.vue）跳到聊天界面执行
async function initPet() {
  petIniting.value = true
  try {
    emit('init-pet')
  } catch (e) {
    console.warn('初始化宠物失败:', e)
    message.error('初始化失败: ' + (e.message || ''))
  } finally {
    petIniting.value = false
  }
}

function openPetWebsite() {
  if (platform.isElectron) {
    window.electronAPI.openExternal('https://petdex.dev/')
  } else {
    window.open('https://petdex.dev/', '_blank')
  }
}
// 技能市场状态
const skillMarket = reactive({
  markets: [],
  currentMarket: '',
  items: [],
  loading: false,
  error: '',
  searchQuery: '',
  searchActive: false,
  installing: null  // 正在安装的 slug
})

// 加载技能市场列表
async function loadSkillMarkets() {
  try {
    const res = await skillMarketAPI.getMarkets()
    if (res.success && res.data && res.data.length > 0) {
      skillMarket.markets = res.data
      skillMarket.currentMarket = res.data[0].name
      loadSkillItems()
    }
  } catch (err) {
    console.warn('加载技能市场失败:', err)
  }
}

// ==================== 关于 / 版本信息 ====================
const aboutInfo = ref({
  name: '-',
  version: '-',
  latestVersion: null,
  hasNewVersion: false,
  releaseUrl: null,
  releaseNotes: null,
  checkTime: null
})
const aboutChecking = ref(false)
const aboutError = ref('')
const electronVersion = ref('')
const autoUpdating = ref(false)
// 更新源（直连/镜像），与更新窗口共享 localStorage
const updateSource = ref(loadUpdateSource())

const emit = defineEmits(['auto-update', 'init-pet'])

// 桌面端版本信息（由 handleCheckVersion 一并更新）
const desktopInfo = ref({
  latestVersion: null,
  hasNewVersion: false,
  releaseUrl: null,
  checkTime: null
})

// 检查更新（同时刷新当前版本和桌面端版本信息）
async function handleCheckVersion() {
  aboutChecking.value = true
  aboutError.value = ''
  // 先刷新当前版本
  await handleRefreshVersion()
  try {
    const res = await systemAPI.checkLatestVersion()
    if (res.success && res.data) {
      // 注意：后端 VersionCheckDTO 返回 currentVersion（不是 version），且无 name
      // 此处合并数据，保留 name 和 version 不被覆盖
      aboutInfo.value = {
        ...aboutInfo.value,
        latestVersion: res.data.latestVersion,
        hasNewVersion: res.data.hasNewVersion,
        releaseUrl: res.data.releaseUrl,
        releaseNotes: res.data.releaseNotes,
        checkTime: res.data.checkTime,
        version: res.data.currentVersion || aboutInfo.value.version
      }
      // 同步更新桌面端版本信息
      if (platform.isElectron) {
        await fetchElectronVersion()
        const ver = electronVersion.value
        if (ver && ver !== '未知' && res.data.latestVersion) {
          desktopInfo.value = {
            ...desktopInfo.value,
            latestVersion: res.data.latestVersion,
            hasNewVersion: compareVersions(ver, res.data.latestVersion) < 0,
            releaseUrl: res.data.releaseUrl || RELEASE_LATEST_URL,
            checkTime: res.data.checkTime
          }
        }
      }
    } else {
      aboutError.value = res.message || '检查版本失败'
    }
  } catch (e) {
    aboutError.value = e.message || '无法连接到服务器'
  } finally {
    aboutChecking.value = false
  }
}

// 刷新当前版本
async function handleRefreshVersion() {
  aboutError.value = ''
  try {
    const res = await systemAPI.getCurrentVersion()
    if (res.success && res.data) {
      aboutInfo.value = {
        ...aboutInfo.value,
        name: res.data.name || '-',
        version: res.data.version || '-'
      }
    }
  } catch (e) {
    aboutError.value = e.message || '无法获取版本信息'
  }
}

// 版本对比工具
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// 自动更新：转发给父组件（App.vue）处理
async function handleAutoUpdateFromPanel() {
  autoUpdating.value = true
  try {
    emit('auto-update')
  } catch (e) {
    console.warn('自动更新失败:', e)
  } finally {
    autoUpdating.value = false
  }
}

// 更新核心服务：桌面端打开独立更新窗口执行在线安装（安装日志与进度在更新窗口中）
async function handleCoreUpdateFromPanel() {
  if (!platform.isElectron) return
  try {
    await window.electronAPI?.updateWindow?.open()
  } catch (e) {
    console.warn('[Settings] failed to open update window:', e)
    message.error('打开更新窗口失败：' + (e.message || '未知错误'))
  }
}

// 将 Markdown 文本渲染为 HTML（用于发布说明）
function renderMarkdown(text) {
  if (!text) return ''
  try {
    return md.render(text)
  } catch {
    return text
  }
}

// 复制文本到剪贴板
function copyText(text) {
  try {
    navigator.clipboard.writeText(text)
    message.success('已复制到剪贴板')
  } catch {
    // 降级方案
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    message.success('已复制到剪贴板')
  }
}

// 加载热门技能
async function loadSkillItems() {
  skillMarket.loading = true
  skillMarket.error = ''
  try {
    const params = {
      action: skillMarket.searchActive && skillMarket.searchQuery ? 'search' : 'trending',
      limit: 50,
      marketName: skillMarket.currentMarket
    }
    if (skillMarket.searchActive && skillMarket.searchQuery) {
      params.q = skillMarket.searchQuery
    }
    const res = await skillMarketAPI.proxy(params)
    if (res.success && res.data) {
      skillMarket.items = res.data
    } else {
      skillMarket.error = res.error || '加载失败'
      skillMarket.items = []
    }
  } catch (err) {
    skillMarket.error = '请求失败: ' + (err.message || err)
    skillMarket.items = []
  } finally {
    skillMarket.loading = false
  }
}

// 搜索技能
function searchSkills() {
  const q = skillMarket.searchQuery.trim()
  skillMarket.searchActive = !!q
  loadSkillItems()
}

// 安装技能
async function installSkill(slug, displayName) {
  skillMarket.installing = slug
  try {
    const res = await skillMarketAPI.install(slug, skillMarket.currentMarket)
    if (res.success) {
      message.success(`技能「${displayName || slug}」安装成功！`)
      // 立即更新本地的已安装集合
      installedSkills.value.add(slug)
      // 重新从后端拉取已安装列表，确保同步
      await loadInstalledSkills()
    } else {
      message.error(res.error || '安装失败')
    }
  } catch (err) {
    message.error('安装失败: ' + (err.message || err))
  } finally {
    skillMarket.installing = null
  }
}

// 卸载技能
async function uninstallSkill(slug, displayName) {
  skillMarket.installing = slug
  try {
    const res = await skillMarketAPI.uninstall(slug)
    if (res.success) {
      message.success(`技能「${displayName || slug}」已卸载`)
      installedSkills.value.delete(slug)
      await loadInstalledSkills()
    } else {
      message.error(res.error || '卸载失败')
    }
  } catch (err) {
    message.error('卸载失败: ' + (err.message || err))
  } finally {
    skillMarket.installing = null
  }
}

// 获取已安装的技能列表。市场 slug 可能与 SKILL.md 的 name 不同，因此两个标识都要保留。
const installedSkills = ref(new Set())
const installedSkillList = ref([])
const installedSkillsLoading = ref(false)
// 已安装技能板块默认折叠
const installedSkillsCollapsed = ref(true)
async function loadInstalledSkills() {
  installedSkillsLoading.value = true
  try {
    const res = await agentAPI.getSkills()
    if (res.success && res.data) {
      installedSkillList.value = Array.isArray(res.data) ? res.data : []
      installedSkills.value = new Set(installedSkillList.value.flatMap(skill => [
        skill.name,
        skill.directoryName
      ].filter(Boolean)))
    }
  } catch (err) {
    console.warn('加载已安装技能失败:', err)
  } finally {
    installedSkillsLoading.value = false
  }
}

function isSkillInstalled(slug) {
  return installedSkills.value.has(slug)
}

// 从「已安装技能」板块卸载技能
function uninstallInstalledSkill(skill) {
  const slug = skill.directoryName || skill.name
  if (!slug) return
  Modal.confirm({
    title: '卸载技能',
    content: `确定要卸载技能「${skill.name || slug}」吗？${skill.directoryName ? `（${skill.directoryName}）` : ''}该目录将被删除，此操作不可恢复。`,
    okText: '卸载',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      skillMarket.installing = slug
      try {
        const res = await skillMarketAPI.uninstall(slug)
        if (res.success) {
          message.success(`技能「${skill.name || slug}」已卸载`)
          installedSkills.value.delete(skill.name)
          installedSkills.value.delete(skill.directoryName)
          installedSkillList.value = installedSkillList.value.filter(s => s !== skill)
        } else {
          message.error(res.error || '卸载失败')
        }
      } catch (err) {
        message.error('卸载失败: ' + (err.message || err))
      } finally {
        skillMarket.installing = null
      }
    }
  })
}

// 标签页配置
const tabs = computed(() => [
  {
    id: 'general',
    label: '基本设置',
    description: '界面主题设置',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>`
  },
  {
    id: 'tools',
    label: '工具',
    description: '查看可用的 AI 工具',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`
  },
  {
    id: 'sub-agents',
    label: '子代理',
    description: '查看内置子代理及其可用工具',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A4 4 0 0 1 21 18v1"/></svg>`
  },
  {
    id: 'dashboard',
    label: '数据面板',
    description: 'Token 用量与活跃度统计',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>`
  },
  {
    id: 'pet',
    label: '宠物',
    description: '桌面宠物选择与预览',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2C8 2 4 5 4 9c0 3 2 6 4 8l4 5 4-5c2-2 4-5 4-8 0-4-4-7-8-7z"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="8" r="1"/><path d="M9 12c1 1 2 2 3 2s2-1 3-2"/>
    </svg>`
  },
  {
    id: 'server',
    label: '服务器',
    description: '后端服务连接配置',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
    </svg>`
  },
  {
    id: 'model-channels',
    label: '模型渠道',
    description: '管理 API 地址、密钥和模型配置',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
      <path d="M7 8h2m4 0h4M7 12h10"/>
    </svg>`
  },
  {
    id: 'workspace',
    label: '项目',
    description: '工作目录和编辑行为配置',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>`
  },
  {
    id: 'plugins',
    label: '插件',
    description: '查看并在线切换 Cutin 运行时插件',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66 4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66 4.24-4.24"/>
      <circle cx="12" cy="12" r="4"/>
    </svg>`
  },
  {
    id: 'extpacks',
    label: '拓展包',
    description: '安装 Solon H-SPI 拓展包扩展 Agent 能力',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>`
  },
  {
    id: 'prompt',
    label: '系统提示词',
    description: '编辑 ~/.loopra/loopra.md 系统提示词文件',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>`
  },
  {
    id: 'openapi',
    label: 'OpenAPI',
    description: '管理 OpenAPI 接口源',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M16 3h5v5M8 3H3v5M3 16v5h5M16 21h5v-5"/>
      <line x1="21" x2="12" y1="3" y2="12"/>
      <line x1="3" x2="12" y1="3" y2="12"/>
      <line x1="21" x2="12" y1="21" y2="12"/>
      <line x1="3" x2="12" y1="21" y2="12"/>
    </svg>`
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    description: '管理 MCP 服务器配置与工具权限',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 6h16M4 12h16M4 18h16"/>
      <circle cx="6" cy="6" r="1.5" fill="currentColor"/>
      <circle cx="6" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="6" cy="18" r="1.5" fill="currentColor"/>
    </svg>`
  },
  {
    id: 'lsp',
    label: 'LSP 服务器',
    description: '配置语言服务器用于代码智能分析',
    icon: `<svg fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="16"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`
  },
  // Electron 桌面端专属设置（已合并到关于页面的 VersionInfoPanel 中）
  {
    id: 'about',
    label: '关于',
    description: '版本信息与更新检查',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>`
  }
])

// 获取 Electron 版本
async function fetchElectronVersion() {
  if (!platform.isElectron) return
  try {
    electronVersion.value = await window.electronAPI.getElectronVersion()
  } catch (e) {
    electronVersion.value = '未知'
    console.warn('获取 Electron 版本失败:', e)
  }
}

// 打开下载页面
async function openDesktopDownload(url) {
  const target = url || RELEASE_LATEST_URL
  if (platform.isElectron) {
    try {
      await window.electronAPI.openExternal(target)
    } catch {
      window.open(target, '_blank')
    }
  } else {
    window.open(target, '_blank')
  }
}

// 主题选项
const themes = [
  {value: 'gray', label: '灰色'},
  {value: 'dark', label: '深色'}
]

// 桌面端判断（系统字体切换仅桌面端可用）
const isDesktop = computed(() => !!(typeof window !== 'undefined' && window.electronAPI?.systemFonts))

// 系统已安装字体列表（桌面端主进程枚举，三端兼容：Windows 注册表 / macOS fc-list→system_profiler / Linux fc-list）
const systemFonts = ref([])
const loadSystemFonts = async () => {
  if (!isDesktop.value) return
  try {
    systemFonts.value = (await window.electronAPI.systemFonts.list()) || []
  } catch (err) {
    console.error('加载系统字体失败:', err)
  }
}

// 计算属性
const currentTab = computed(() => tabs.value.find(t => t.id === activeTab.value))

// 监听设置变化
watch(settings, () => {
  hasChanges.value = true
}, {deep: true})

// 监听 Tab 切换
watch(activeTab, async (tab) => {
  if (tab === 'mcp') {
    // MCP 状态在本文件后段声明；延后一轮微任务，兼容以 MCP 页签直接打开设置。
    queueMicrotask(() => {
      if (mcpServers.value.length === 0) loadMcpServers()
      if (!mcpExportLoaded.value) loadMcpExport()
      if (!mcpTunnelLoaded.value) loadMcpTunnel()
    })
  }
  if (tab === 'lsp' && lspServers.value.length === 0) {
    loadLspServers()
  }
  if (tab === 'skill-market') {
    // 先加载已安装技能列表，确保渲染市场列表时就有安装状态
    await loadInstalledSkills()
    loadSkillMarkets()
  }
  if (tab === 'about') {
    // 进入关于页面时自动检查更新（含版本刷新+远程检查）
    handleCheckVersion()
  }
  if (tab === 'pet') {
    loadPets()
  }
  if (tab === 'prompt') {
    loadLoopraMd()
  }
  if (tab === 'plugins') {
    loadPlugins()
  }
  if (tab === 'extpacks') {
    loadExtPacks()
  }
}, {immediate: true})

watch(() => props.initialTab, (tab) => {
  activeTab.value = tab === 'ai' ? 'general' : (tab || 'general')
})

// 加载设置
const loadSettings = async () => {
  loading.value = true
  try {
    const [configResponse, modelsResponse] = await Promise.all([
      configAPI.getConfig(),
      configAPI.getModels()
    ])

    if (configResponse.success && configResponse.data) {
      const config = configResponse.data
      // 优先读 localStorage 中实际连接的地址
      settings.server.apiBaseUrl = localStorage.getItem('loopra-api-base') || config.serverApiBaseUrl || ''
      settings.ai.baseUrl = config.baseUrl || ''
      // 记录原始值，用于检测 baseUrl/apiKey 是否变更
      originalBaseUrl.value = settings.ai.baseUrl
      // 从 localStorage 读取上次保存的 apiKey，用于后续对比
      // 注意：出于安全考虑，保存成功后会清空 localStorage 中的明文密钥
      // 因此此处不再回填到输入框，用户需重新输入才能再次保存
      // getLastSavedApiKey() 保留用于保存时的变更检测
      settings.ai.model = config.model || ''
      settings.ai.reasoningEffort = config.reasoningEffort || 'max'

      if (config.availableModels && Array.isArray(config.availableModels)) {
        settings.ai.availableModelsText = config.availableModels.join('\n')
      }

      settings.workspace.dir = config.workspaceDir || config.workspace || '.'
      settings.workspace.mode = config.hitl === true ? 'approval' : (config.hitl || 'free')

      // 加载模型价格
      if (config.price && typeof config.price === 'object') {
        settings.ai.prices = JSON.parse(JSON.stringify(config.price))
      }

      // 加载安全设置
      if (config.security) {
        Object.assign(settings.security, config.security)
      }

      // 加载禁用工具列表
      if (config.disabledTools && Array.isArray(config.disabledTools)) {
        settings.security.disabledToolsText = config.disabledTools.join('\n')
      }

      // 加载活跃宠物名称
      if (config.activePet) {
        activePetName.value = config.activePet
      store.activePetName = config.activePet || ''
      }

    } else {
      message.error(configResponse.error || '加载配置失败')
    }

    if (modelsResponse.success && modelsResponse.data) {
      availableModels.value = modelsResponse.data.models || []
    }
  } catch (err) {
    console.error('加载配置失败:', err)
    message.error('加载配置失败: ' + err.message)

    // 设置默认值
    settings.ai.baseUrl = 'https://api.deepseek.com/v1'
    settings.ai.model = 'deepseek-v4-flash'
    settings.ai.reasoningEffort = 'max'
    settings.workspace.dir = '.'
    settings.workspace.mode = 'free'
    availableModels.value = [
      {name: 'deepseek-v4-flash', active: true},
      {name: 'gpt-4', active: false},
      {name: 'gpt-4-turbo', active: false},
      {name: 'gpt-3.5-turbo', active: false}
    ]
  } finally {
    loading.value = false
    hasChanges.value = false
  }
}

// 保存设置
const saveSettings = async () => {
  loading.value = true
  try {
    // 同步更新 localStorage 中的实际连接地址
    if (settings.server.apiBaseUrl && settings.server.apiBaseUrl.trim()) {
      localStorage.setItem('loopra-api-base', settings.server.apiBaseUrl.trim())
    }

    // 准备配置更新
    const configToUpdate = {
      hitl: settings.workspace.mode,
      reasoningEffort: settings.ai.reasoningEffort,
      security: {...settings.security},
      disabledTools: settings.security.disabledToolsText.split('\n').map(s => s.trim()).filter(s => s)
    }

    const response = await configAPI.updateConfig(configToUpdate)

    if (response.success) {
      // 切换工作目录
      if (settings.workspace.dir && settings.workspace.dir.trim()) {
        try {
          await configAPI.switchWorkspace(settings.workspace.dir.trim())
        } catch (e) {
          console.warn('切换工作目录失败:', e)
        }
      }

      const serverMsg = typeof response.data === 'string'
          ? response.data
          : (response.data?.message || '设置已保存')
      message.success(serverMsg)
      hasChanges.value = false
    } else {
      message.error(response.error || '保存失败')
    }
  } catch (err) {
    console.error('保存配置失败:', err)
    message.error('保存失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

// 测试服务器连接
const checkServerConnection = async () => {
  checkingConnection.value = true
  connectionChecked.value = false

  try {
    const baseUrl = settings.server.apiBaseUrl.trim() || '/api'
    const url = baseUrl.endsWith('/api')
        ? baseUrl + '/agent/status'
        : baseUrl.replace(/\/+$/, '') + '/api/agent/status'

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000)
    })
    connectionOk.value = resp.ok
  } catch {
    connectionOk.value = false
  }

  connectionChecked.value = true
  checkingConnection.value = false
}

// 从远程 API 获取模型列表并打开弹窗
const openRemoteModelsDialog = async () => {
  remoteModelsLoading.value = true
  showRemoteModelsDialog.value = true
  try {
    const res = await configAPI.getRemoteModels()
    if (res.success && res.data && res.data.length > 0) {
      remoteModelList.value = res.data
      // 默认选中已在文本域中的模型
      const existing = new Set(
          settings.ai.availableModelsText.split('\n').map(s => s.trim()).filter(s => s)
      )
      selectedRemoteModels.value = new Set(
          res.data.filter(m => existing.has(m))
      )
    } else {
      remoteModelList.value = []
      selectedRemoteModels.value = new Set()
      message.error(res.error || '获取远端模型列表失败')
    }
  } catch (err) {
    console.error('获取远端模型列表失败:', err)
    message.error('获取远端模型列表失败: ' + (err.message || err))
    showRemoteModelsDialog.value = false
  } finally {
    remoteModelsLoading.value = false
  }
}

// 勾选/取消单个模型
const toggleModel = (name) => {
  const s = new Set(selectedRemoteModels.value)
  if (s.has(name)) {
    s.delete(name)
  } else {
    s.add(name)
  }
  selectedRemoteModels.value = s
}

// 全选/取消全选
const toggleSelectAll = () => {
  if (selectedRemoteModels.value.size === filteredRemoteModelList.value.length) {
    // 全部已选 → 取消全选（仅取消当前过滤列表中的项）
    const s = new Set(selectedRemoteModels.value)
    filteredRemoteModelList.value.forEach(m => s.delete(m))
    selectedRemoteModels.value = s
  } else {
    // 选中过滤列表中的所有项
    const s = new Set(selectedRemoteModels.value)
    filteredRemoteModelList.value.forEach(m => s.add(m))
    selectedRemoteModels.value = s
  }
}

// 确认填入文本域
const confirmRemoteModels = () => {
  const selected = Array.from(selectedRemoteModels.value).sort()
  settings.ai.availableModelsText = selected.join('\n')
  // 同步更新 model 下拉列表
  availableModels.value = selected.map(name => ({
    name,
    active: name === settings.ai.model
  }))
  message.success(`已填入 ${selected.length} 个模型`)
  showRemoteModelsDialog.value = false
}

// 搜索过滤后的模型列表
const filteredRemoteModelList = computed(() => {
  const q = remoteSearchQuery.value.trim().toLowerCase()
  if (!q) return remoteModelList.value
  return remoteModelList.value.filter(m => m.toLowerCase().includes(q))
})

// ==================== 自动填入配置 ====================
const autoFillUrl = ref('')
const autoFillApiKey = ref('')
const autoFillPreset = ref('')
const showAutoFillDialog = ref(false)

// 添加模型价格弹窗状态
const showAddPriceDialog = ref(false)
const newPriceModelName = ref('')

// 选择预设服务商时自动填充 URL
const onPresetChange = () => {
  if (autoFillPreset.value) {
    autoFillUrl.value = autoFillPreset.value
  }
}

// 通用自动填入逻辑
const doAutoFill = async ({ url, key, configPayload, fetchModels, onModelsSuccess, onModelsFail }) => {
  // 填入配置
  hasChanges.value = true

  // 保存到后端
  try {
    await configAPI.updateConfig(configPayload)
  } catch { /* 不阻断 */ }

  // 获取远端模型列表
  try {
    const res = await fetchModels()
    if (res.success && res.data && res.data.length > 0) {
      onModelsSuccess(res.data)
      message.success(`已自动填入 ${url}，发现 ${res.data.length} 个模型`)
    } else {
      onModelsFail()
      message.success(`已填入 API 地址和密钥`)
    }
  } catch {
    onModelsFail()
    message.success(`已填入 API 地址和密钥`)
  }
}

// 打开自动填入弹窗。
const openAutoFillDialog = () => {
  autoFillUrl.value = settings.ai.baseUrl || ''
  autoFillApiKey.value = settings.ai.apiKey || ''
  autoFillPreset.value = ''
  showAutoFillDialog.value = true
}

// 确认自动填入
const confirmAutoFill = async () => {
  const url = autoFillUrl.value.trim().replace(/\/+$/, '')
  const key = autoFillApiKey.value.trim()
  if (!url || !key) {
    message.warning('请填写 API 地址和密钥')
    return
  }

  const confirm = await new Promise((resolve) => {
    Modal.confirm({
        title: '更改 API 地址或密钥将重置 Agent',
        content: '修改 API 地址或密钥后，系统将重新初始化 Agent，当前活跃的会话将被保存并关闭。\n\n要继续自动填入吗？',
        okText: '确认填入',
        cancelText: '取消',
        onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
  if (!confirm) return

  settings.ai.baseUrl = url
  settings.ai.apiKey = key

  await doAutoFill({
    url,
    key,
    configPayload: { baseUrl: url, apiKey: key },
    fetchModels: () => configAPI.getRemoteModels(),
    onModelsSuccess: (data) => {
      settings.ai.availableModelsText = data.join('\n')
      settings.ai.model = data[0]
    },
    onModelsFail: () => {}
  })

  showAutoFillDialog.value = false
}

// ==================== 模型价格操作 ====================

// 添加模型价格行
const addPriceModel = () => {
  newPriceModelName.value = ''
  showAddPriceDialog.value = true
}

const confirmAddPrice = () => {
  const name = newPriceModelName.value.trim()
  if (!name) {
    message.warning('请输入模型名称')
    return
  }
  if (settings.ai.prices[name]) {
    message.warning('该模型已存在价格配置')
    return
  }
  settings.ai.prices = {
    ...settings.ai.prices,
    [name]: {input: 0, cache: 0, output: 0}
  }
  hasChanges.value = true
  showAddPriceDialog.value = false
}

// 删除模型价格行
const removePriceModel = (modelName) => {
  const newPrices = {...settings.ai.prices}
  delete newPrices[modelName]
  settings.ai.prices = newPrices
  hasChanges.value = true
}

// 重命名模型
const renamePriceModel = (oldName, newName) => {
  if (!newName || !newName.trim() || oldName === newName.trim()) return
  const key = newName.trim()
  const newPrices = {...settings.ai.prices}
  newPrices[key] = newPrices[oldName]
  delete newPrices[oldName]
  settings.ai.prices = newPrices
  hasChanges.value = true
}

// 更新价格值
const updatePriceValue = (modelName, field, value) => {
  const num = parseFloat(value)
  if (isNaN(num)) return
  settings.ai.prices = {
    ...settings.ai.prices,
    [modelName]: {
      ...settings.ai.prices[modelName],
      [field]: num
    }
  }
  hasChanges.value = true
}

// 从模型列表生成价格条目（用默认价格 0）
const fillPricesFromModels = () => {
  const models = settings.ai.availableModelsText.split('\n').map(s => s.trim()).filter(s => s)
  if (models.length === 0) {
    message.warning('请先在"可用模型列表"中填写模型名称')
    return
  }
  const newPrices = {...settings.ai.prices}
  models.forEach(m => {
    if (!newPrices[m]) {
      newPrices[m] = {input: 0, cache: 0, output: 0}
    }
  })
  settings.ai.prices = newPrices
  hasChanges.value = true
  message.success(`已从模型列表生成 ${models.length} 个价格条目`)
}

const openapiLoading = ref(false)
const openapiError = ref('')
const openapiSubmitting = ref(false)
const showAddDialog = ref(false)
const editingSource = ref(null)
const openapiSources = ref([])

// 搜索
const searchKeyword = ref('')
const searchResult = ref(null)
const searching = ref(false)

const form = ref({
  docUrl: '', headerList: [],
  authType: 'none', authConfig: {},
  bearerToken: '', apiKeyName: '', apiKeyValue: '', basicUser: '', basicPass: ''
})

function statusLabel(s) {
  return {loaded: '已加载', error: '失败', disabled: '禁用'}[s] || s
}

function authLabel(source) {
  if (!source.authType || source.authType === 'none') return ''
  const c = source.authConfig || {}
  if (source.authType === 'bearer') return 'Bearer Token'
  if (source.authType === 'apikey') return `API Key (${c.name || ''})`
  if (source.authType === 'basic') return `Basic (${c.username || ''})`
  return source.authType
}

// 搜索
async function doSearch() {
  const kw = searchKeyword.value.trim()
  if (!kw) return
  searching.value = true
  try {
    const res = await openApiAPI.searchApis(kw)
    searchResult.value = res.data
  } catch (e) {
    searchResult.value = '搜索失败: ' + (e.message || '')
  } finally {
    searching.value = false
  }
}

function clearSearch() {
  searchKeyword.value = ''
  searchResult.value = null
}

async function loadOpenApiData() {
  openapiLoading.value = true
  openapiError.value = ''
  try {
    const sr = await openApiAPI.getSources()
    openapiSources.value = (sr.data || []).filter(s => s.docUrl)
    message.success('刷新成功')
  } catch (e) {
    openapiError.value = e.message || '加载失败'
    message.error('刷新失败: ' + (e.message || ''))
  } finally {
    openapiLoading.value = false
  }
}

// 打开对话框
function openAdd() {
  editingSource.value = null
  resetForm()
  showAddDialog.value = true
}

function openEdit(source) {
  editingSource.value = source
  form.value.docUrl = source.docUrl || ''

  const hl = []
  if (source.headers) {
    for (const [k, v] of Object.entries(source.headers)) {
      hl.push({key: k, value: v})
    }
  }
  form.value.headerList = hl

  const authType = source.authType || 'none'
  form.value.authType = authType
  const ac = source.authConfig || {}
  form.value.bearerToken = ac.token || ''
  form.value.apiKeyName = ac.name || ''
  form.value.apiKeyValue = ac.value || ''
  form.value.basicUser = ac.username || ''
  form.value.basicPass = ac.password || ''

  showAddDialog.value = true
}

function resetForm() {
  form.value = {
    docUrl: '', headerList: [],
    authType: 'none', authConfig: {},
    bearerToken: '', apiKeyName: '', apiKeyValue: '', basicUser: '', basicPass: ''
  }
}

// 提交
async function submitAdd() {
  if (!form.value.docUrl) {
    message.warning('请填写文档地址')
    return
  }
  openapiSubmitting.value = true
  try {
    const headers = {}
    form.value.headerList.forEach(h => {
      if (h.key && h.value) headers[h.key] = h.value
    })

    let authType = form.value.authType || 'none'
    let authConfig = null
    if (authType === 'bearer' && form.value.bearerToken) {
      authConfig = {token: form.value.bearerToken}
    } else if (authType === 'apikey' && form.value.apiKeyName && form.value.apiKeyValue) {
      authConfig = {name: form.value.apiKeyName, value: form.value.apiKeyValue}
    } else if (authType === 'basic' && form.value.basicUser && form.value.basicPass) {
      authConfig = {username: form.value.basicUser, password: form.value.basicPass}
    } else {
      authType = 'none'
    }

    if (editingSource.value) {
      const oldDocUrl = editingSource.value.docUrl
      if (oldDocUrl === form.value.docUrl) {
        const res = await openApiAPI.refreshSource(form.value.docUrl, headers, authType, authConfig)
        if (res.success !== false) {
          message.success('修改成功')
        } else {
          message.error(res.error || '修改失败')
          openapiSubmitting.value = false
          return
        }
      } else {
        await openApiAPI.removeSource(oldDocUrl)
        const res = await openApiAPI.addSource(form.value.docUrl, headers, authType, authConfig)
        if (res.success !== false) {
          message.success('修改成功')
        } else {
          message.error(res.error || '修改失败')
          openapiSubmitting.value = false
          return
        }
      }
    } else {
      const res = await openApiAPI.addSource(form.value.docUrl, headers, authType, authConfig)
      if (res.success !== false) {
        message.success('添加成功')
      } else {
        message.error(res.error || '添加失败')
        openapiSubmitting.value = false
        return
      }
    }

    showAddDialog.value = false
    resetForm()
    editingSource.value = null
    await loadOpenApiData()
  } catch (e) {
    message.error('操作失败: ' + (e.message || ''))
  } finally {
    openapiSubmitting.value = false
  }
}

async function refreshSource(source) {
  openapiLoading.value = true
  try {
    const res = await openApiAPI.refreshSource(
        source.docUrl,
        source.headers || {},
        source.authType || 'none',
        source.authConfig || null
    )
    console.log('刷新响应:', res)
    if (res && res.success !== false) {
      message.success('刷新成功')
      await loadOpenApiData()
    } else {
      message.error(res?.error || '刷新失败')
    }
  } catch (e) {
    console.error('刷新失败:', e)
    message.error('刷新失败: ' + (e.message || ''))
  } finally {
    openapiLoading.value = false
  }
}

async function removeSource(source) {
  if (!confirm(`确定移除接口源「${source.docUrl}」？`)) return
  try {
    const res = await openApiAPI.removeSource(source.docUrl)
    if (res.success !== false) {
      message.success('已移除')
      await loadOpenApiData()
    } else {
      message.error(res.error || '移除失败')
    }
  } catch (e) {
    message.error('移除失败: ' + (e.message || ''))
  }
}

// ==================== MCP 服务器管理 ====================
const mcpLoading = ref(false)
const mcpSaving = ref(false)
const mcpChecking = ref(false)
const mcpCheckResult = ref(null)
const mcpServers = ref([])
const currentMcpView = ref('list') // list | form | tools
const mcpEditName = ref(null)

const mcpForm = reactive({
  name: '',
  type: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  timeout: '',
  enabled: true
})

// 工具管理
const mcpToolsLoading = ref(false)
const mcpToolsSaving = ref(false)
const mcpToolsServerName = ref('')
const mcpToolsConnected = ref(false)
const mcpTools = ref([])
const mcpDisallowedTools = ref([])

// Loopra 内置工具 MCP 发布
const mcpExportLoading = ref(false)
const mcpExportSaving = ref(false)
const mcpExportRefreshing = ref(false)
const mcpExportLoaded = ref(false)
const mcpExportSelectionMode = ref('all') // all | selected
const mcpExportSelectedTools = ref([])
const mcpExportTools = ref([])
const mcpExportEndpointPreview = ref('/mcp')
const mcpExport = reactive({
  enabled: false,
  name: 'loopra',
  version: '1.0.0',
  channel: 'streamable',
  endpoint: '/mcp'
})

// Cloudflare Quick Tunnel
const mcpTunnelLoading = ref(false)
const mcpTunnelSaving = ref(false)
const mcpTunnelStarting = ref(false)
const mcpTunnelStopping = ref(false)
const mcpTunnelLoaded = ref(false)
const mcpTunnelConfig = reactive({
  executablePath: ''
})
const mcpTunnel = reactive({
  state: 'stopped',
  running: false,
  installed: false,
  quickTunnel: true,
  mcpReady: false,
  platform: '',
  configuredExecutablePath: '',
  executablePath: '',
  localUrl: '',
  publicUrl: '',
  mcpEndpoint: '/mcp',
  error: '',
  pid: 0
})
let mcpTunnelPollTimer = null

// 计算属性
const mcpDisallowedSet = computed(() => new Set(mcpDisallowedTools.value))

const mcpEnabledCount = computed(() => {
  return mcpTools.value.filter(t => !mcpDisallowedSet.value.has(t.name)).length
})

const mcpAllToolsChecked = computed(() => {
  return mcpTools.value.length > 0 && mcpEnabledCount.value === mcpTools.value.length
})

const mcpExportSelectedSet = computed(() => new Set(mcpExportSelectedTools.value))

const mcpExportEnabledToolCount = computed(() => {
  return mcpExportTools.value.filter(tool => tool.enabled).length
})

const mcpExportCheckedCount = computed(() => {
  if (mcpExportSelectionMode.value === 'all') return mcpExportEnabledToolCount.value
  return mcpExportTools.value.filter(tool => tool.enabled && mcpExportSelectedSet.value.has(tool.name)).length
})

const mcpExportEndpointUrl = computed(() => {
  const endpoint = mcpExportEndpointPreview.value || mcpExport.endpoint || '/mcp'
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : ''
  return `${origin}${endpoint}`
})

const mcpTunnelStateLabel = computed(() => ({
  stopped: '未启动',
  starting: '连接中',
  running: '已发布',
  stopping: '停止中',
  error: '异常'
}[mcpTunnel.state] || '未启动'))

const mcpFormValid = computed(() => {
  if (!mcpForm.name || !/^[a-zA-Z0-9_-]+$/.test(mcpForm.name)) return false
  if (!mcpForm.type) return false
  if (mcpForm.type === 'stdio') {
    return !!mcpForm.command
  }
  if (mcpForm.type === 'sse' || mcpForm.type === 'streamable') {
    return !!mcpForm.url && (mcpForm.url.startsWith('http://') || mcpForm.url.startsWith('https://'))
  }
  return false
})

// 辅助函数
function typeIcon(type) {
  return {stdio: 'S', sse: 'R', streamable: 'H'}[type] || '?'
}

function typeLabel(type) {
  return {stdio: 'stdio', sse: 'sse', streamable: 'streamable'}[type] || type
}

function resetMcpForm() {
  mcpForm.name = ''
  mcpForm.type = 'stdio'
  mcpForm.command = ''
  mcpForm.argsText = ''
  mcpForm.envText = ''
  mcpForm.url = ''
  mcpForm.headersText = ''
  mcpForm.timeout = ''
  mcpForm.enabled = true
  mcpCheckResult.value = null
}

// 解析表单数据为后端格式
function buildMcpServerData() {
  const data = {
    name: mcpForm.name,
    type: mcpForm.type,
    enabled: mcpForm.enabled
  }
  if (mcpForm.type === 'stdio') {
    data.command = mcpForm.command
    data.args = mcpForm.argsText
      ? mcpForm.argsText.split('\n').map(s => s.trim()).filter(s => s)
      : []
    data.env = {}
    mcpForm.envText.split('\n').forEach(line => {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.substring(0, idx).trim()
        const v = line.substring(idx + 1).trim()
        if (k) data.env[k] = v
      }
    })
  } else {
    data.url = mcpForm.url
    data.headers = {}
    mcpForm.headersText.split('\n').forEach(line => {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.substring(0, idx).trim()
        const v = line.substring(idx + 1).trim()
        if (k) data.headers[k] = v
      }
    })
    data.timeout = mcpForm.timeout || ''
  }
  return data
}

// 加载服务器列表
async function loadMcpServers() {
  mcpLoading.value = true
  try {
    const res = await mcpAPI.listServers()
    if (res.success !== false) {
      mcpServers.value = res.data || []
    } else {
      message.error(res.error || '加载 MCP 服务器列表失败')
    }
  } catch (e) {
    console.error('加载 MCP 服务器列表失败:', e)
    message.error('加载失败: ' + (e.message || ''))
  } finally {
    mcpLoading.value = false
  }
}

// 加载 Loopra 内置工具 MCP 发布配置
async function loadMcpExport() {
  if (mcpExportLoading.value) return
  mcpExportLoading.value = true
  try {
    const res = await mcpAPI.getExportConfig()
    if (res.success !== false) {
      applyMcpExportConfig(res.data || {})
    } else {
      message.error(res.error || '加载 Loopra MCP 发布配置失败')
    }
  } catch (e) {
    console.error('加载 Loopra MCP 发布配置失败:', e)
    message.error('加载失败: ' + (e.message || ''))
  } finally {
    mcpExportLoading.value = false
    mcpExportLoaded.value = true
  }
}

function applyMcpExportConfig(data) {
  mcpExport.enabled = data.enabled === true
  mcpExport.name = data.name || 'loopra'
  mcpExport.version = data.version || '1.0.0'
  mcpExport.channel = ['sse', 'streamable_stateless'].includes(data.channel)
    ? data.channel
    : 'streamable'
  mcpExport.endpoint = data.endpoint || '/mcp'
  mcpExportEndpointPreview.value = data.endpointUrl || mcpExport.endpoint
  mcpExportTools.value = Array.isArray(data.tools) ? data.tools : []

  if (Array.isArray(data.allowedTools)) {
    mcpExportSelectionMode.value = 'selected'
    mcpExportSelectedTools.value = [...new Set(data.allowedTools)]
  } else {
    mcpExportSelectionMode.value = 'all'
    mcpExportSelectedTools.value = mcpExportTools.value
      .filter(tool => tool.enabled)
      .map(tool => tool.name)
  }
}

function setMcpExportSelectionMode(mode) {
  if (mode === 'selected' && mcpExportSelectionMode.value !== 'selected') {
    mcpExportSelectedTools.value = mcpExportTools.value
      .filter(tool => tool.enabled)
      .map(tool => tool.name)
  }
  mcpExportSelectionMode.value = mode
}

function isMcpExportToolSelected(tool) {
  return tool.enabled && (mcpExportSelectionMode.value === 'all'
    || mcpExportSelectedSet.value.has(tool.name))
}

function toggleMcpExportTool(tool) {
  if (!tool.enabled) return
  const selected = new Set(mcpExportSelectedTools.value)
  if (selected.has(tool.name)) {
    selected.delete(tool.name)
  } else {
    selected.add(tool.name)
  }
  mcpExportSelectedTools.value = [...selected]
}

function selectMcpExportTools(checked) {
  mcpExportSelectedTools.value = checked
    ? mcpExportTools.value.filter(tool => tool.enabled).map(tool => tool.name)
    : []
}

async function saveMcpExport() {
  mcpExportSaving.value = true
  try {
    const allowedTools = mcpExportSelectionMode.value === 'all'
      ? null
      : [...new Set(mcpExportSelectedTools.value)]
    const res = await mcpAPI.saveExportConfig({
      enabled: mcpExport.enabled,
      name: mcpExport.name,
      version: mcpExport.version,
      channel: mcpExport.channel,
      endpoint: mcpExport.endpoint,
      allowedTools
    })
    if (res.success !== false) {
      applyMcpExportConfig(res.data || {})
      message.success('Loopra MCP 发布配置已保存')
      if (mcpTunnelLoaded.value) loadMcpTunnel()
    } else {
      message.error(res.error || '保存失败')
    }
  } catch (e) {
    message.error('保存失败: ' + (e.message || ''))
  } finally {
    mcpExportSaving.value = false
  }
}

async function refreshMcpExportTools() {
  if (mcpExportRefreshing.value) return
  mcpExportRefreshing.value = true
  try {
    const res = await mcpAPI.refreshExportTools()
    if (res.success !== false) {
      applyMcpExportConfig(res.data || {})
      message.success('工具清单已刷新')
    } else {
      message.error(res.error || '刷新失败')
    }
  } catch (e) {
    message.error('刷新失败: ' + (e.message || ''))
  } finally {
    mcpExportRefreshing.value = false
  }
}

// 加载 Cloudflare Quick Tunnel 状态
async function loadMcpTunnel() {
  if (mcpTunnelLoading.value) return
  mcpTunnelLoading.value = true
  try {
    const res = await mcpAPI.getTunnelStatus()
    if (res.success !== false) {
      applyMcpTunnelStatus(res.data || {})
    } else {
      message.error(res.error || '加载 Cloudflare 隧道状态失败')
    }
  } catch (e) {
    console.error('加载 Cloudflare 隧道状态失败:', e)
    message.error('加载失败: ' + (e.message || ''))
  } finally {
    mcpTunnelLoading.value = false
    mcpTunnelLoaded.value = true
  }
}

function applyMcpTunnelStatus(data) {
  Object.assign(mcpTunnel, {
    state: data.state || 'stopped',
    running: data.running === true,
    installed: data.installed === true,
    quickTunnel: data.quickTunnel !== false,
    mcpReady: data.mcpReady === true,
    platform: data.platform || '',
    configuredExecutablePath: data.configuredExecutablePath || '',
    executablePath: data.executablePath || '',
    localUrl: data.localUrl || '',
    publicUrl: data.publicUrl || '',
    mcpEndpoint: data.mcpEndpoint || '/mcp',
    error: data.error || '',
    pid: Number(data.pid) || 0
  })
  if (data.configuredExecutablePath !== undefined) {
    mcpTunnelConfig.executablePath = data.configuredExecutablePath || ''
  }
  if (mcpTunnel.running || ['starting', 'stopping'].includes(mcpTunnel.state)) {
    startMcpTunnelPolling()
  } else {
    stopMcpTunnelPolling()
  }
}

function startMcpTunnelPolling() {
  if (mcpTunnelPollTimer) return
  mcpTunnelPollTimer = setInterval(() => {
    loadMcpTunnel()
  }, 2000)
}

function stopMcpTunnelPolling() {
  if (!mcpTunnelPollTimer) return
  clearInterval(mcpTunnelPollTimer)
  mcpTunnelPollTimer = null
}

async function saveMcpTunnelConfig() {
  mcpTunnelSaving.value = true
  try {
    const res = await mcpAPI.saveTunnelConfig({
      executablePath: mcpTunnelConfig.executablePath
    })
    if (res.success !== false) {
      applyMcpTunnelStatus(res.data || {})
      message.success('Cloudflare 隧道配置已保存')
    } else {
      message.error(res.error || '保存失败')
    }
  } catch (e) {
    message.error('保存失败: ' + (e.message || ''))
  } finally {
    mcpTunnelSaving.value = false
  }
}

async function startMcpTunnel() {
  if (!mcpExport.enabled) {
    message.warning('请先启用上面的 Loopra MCP 工具发布')
    return
  }
  if (mcpExport.channel === 'sse') {
    message.warning('Cloudflare Quick Tunnel 不支持 SSE，请切换为 Streamable HTTP')
    return
  }
  mcpTunnelStarting.value = true
  try {
    const res = await mcpAPI.startTunnel({
      executablePath: mcpTunnelConfig.executablePath
    })
    if (res.success !== false) {
      applyMcpTunnelStatus(res.data || {})
      if (mcpTunnel.running) {
        message.success('Cloudflare 临时隧道已启动')
      } else {
        message.info('cloudflared 正在连接，稍后会显示公网地址')
      }
      startMcpTunnelPolling()
    } else {
      message.error(res.error || '启动隧道失败')
    }
  } catch (e) {
    message.error('启动隧道失败: ' + (e.message || ''))
  } finally {
    mcpTunnelStarting.value = false
  }
}

async function stopMcpTunnel() {
  mcpTunnelStopping.value = true
  try {
    const res = await mcpAPI.stopTunnel()
    if (res.success !== false) {
      applyMcpTunnelStatus(res.data || {})
      message.success('Cloudflare 隧道已停止')
    } else {
      message.error(res.error || '停止隧道失败')
    }
  } catch (e) {
    message.error('停止隧道失败: ' + (e.message || ''))
  } finally {
    mcpTunnelStopping.value = false
    stopMcpTunnelPolling()
  }
}

async function copyMcpTunnelUrl() {
  if (!mcpTunnel.publicUrl) return
  try {
    await navigator.clipboard.writeText(mcpTunnel.publicUrl)
    message.success('公网 MCP 地址已复制')
  } catch (e) {
    message.error('复制失败，请手动复制')
  }
}

// 打开新增表单
function openMcpAdd() {
  mcpEditName.value = null
  resetMcpForm()
  currentMcpView.value = 'form'
}

// 打开编辑表单
function openMcpEdit(svr) {
  mcpEditName.value = svr.name
  mcpForm.name = svr.name
  mcpForm.type = svr.type || 'stdio'
  mcpForm.enabled = svr.enabled !== false
  if (svr.type === 'stdio') {
    mcpForm.command = svr.command || ''
    mcpForm.argsText = (svr.args || []).join('\n')
    mcpForm.envText = ''
    if (svr.env) {
      mcpForm.envText = Object.entries(svr.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    }
    mcpForm.url = ''
    mcpForm.headersText = ''
    mcpForm.timeout = ''
  } else {
    mcpForm.url = svr.url || ''
    mcpForm.headersText = ''
    if (svr.headers) {
      mcpForm.headersText = Object.entries(svr.headers)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    }
    mcpForm.timeout = svr.timeout || ''
    mcpForm.command = ''
    mcpForm.argsText = ''
    mcpForm.envText = ''
  }
  mcpCheckResult.value = null
  currentMcpView.value = 'form'
}

// 返回列表
function backToMcpList() {
  currentMcpView.value = 'list'
  mcpCheckResult.value = null
  loadMcpServers()
}

// 保存服务器
async function saveMcpServer() {
  if (!mcpFormValid.value) {
    message.warning('请完善必填字段')
    return
  }
  mcpSaving.value = true
  try {
    const data = buildMcpServerData()
    let res
    if (mcpEditName.value) {
      res = await mcpAPI.updateServer(mcpEditName.value, data)
    } else {
      res = await mcpAPI.addServer(data)
    }
    if (res.success !== false) {
      message.success(mcpEditName.value ? '修改成功' : '添加成功')
      backToMcpList()
    } else {
      message.error(res.error || '操作失败')
    }
  } catch (e) {
    message.error('操作失败: ' + (e.message || ''))
  } finally {
    mcpSaving.value = false
  }
}

// 删除服务器
async function deleteMcpServer(name) {
  if (!confirm(`确定删除 MCP 服务器「${name}」？`)) return
  try {
    const res = await mcpAPI.removeServer(name)
    if (res.success !== false) {
      message.success('已删除')
      backToMcpList()
    } else {
      message.error(res.error || '删除失败')
    }
  } catch (e) {
    message.error('删除失败: ' + (e.message || ''))
  }
}

// 复制服务器
async function copyMcpServer() {
  const newName = mcpForm.name + '-copy'
  mcpEditName.value = null
  mcpForm.name = newName
  message.success('已创建副本，可修改后保存')
}

// 启用/禁用
async function toggleMcpServer(svr) {
  const newEnabled = !svr.enabled
  try {
    const res = await mcpAPI.toggleServer(svr.name, newEnabled)
    if (res.success !== false) {
      svr.enabled = newEnabled
    } else {
      message.error(res.error || '操作失败')
    }
  } catch (e) {
    message.error('操作失败: ' + (e.message || ''))
  }
}

// 检测连接
async function checkMcpConnection() {
  if (!mcpFormValid.value) {
    message.warning('请先完善必填字段')
    return
  }
  mcpChecking.value = true
  mcpCheckResult.value = null
  try {
    const data = buildMcpServerData()
    const res = await mcpAPI.checkConnection(data)
    if (res.success !== false) {
      mcpCheckResult.value = {ok: true, message: '连接成功'}
    } else {
      mcpCheckResult.value = {ok: false, message: res.error || '连接失败，请检查服务器配置'}
    }
  } catch (e) {
    mcpCheckResult.value = {ok: false, message: e.message || '连接超时，请检查服务器是否可达'}
  } finally {
    mcpChecking.value = false
  }
}

// 打开工具列表
async function openMcpTools(svr) {
  mcpToolsServerName.value = svr.name
  mcpToolsLoading.value = true
  mcpTools.value = []
  mcpToolsConnected.value = false
  mcpDisallowedTools.value = []
  currentMcpView.value = 'tools'
  try {
    const res = await mcpAPI.listTools(svr.name)
    if (res.success !== false) {
      const d = res.data || {}
      mcpToolsConnected.value = d.connected !== false
      mcpTools.value = d.tools || []
      mcpDisallowedTools.value = d.disallowedTools || []
    } else {
      message.error(res.error || '加载工具列表失败')
    }
  } catch (e) {
    message.error('加载失败: ' + (e.message || ''))
  } finally {
    mcpToolsLoading.value = false
  }
}

// 切换单个工具
function toggleMcpTool(name) {
  const set = new Set(mcpDisallowedTools.value)
  if (set.has(name)) {
    set.delete(name)
  } else {
    set.add(name)
  }
  mcpDisallowedTools.value = Array.from(set)
}

// 全选/取消全选
function toggleAllMcpTools() {
  if (mcpAllToolsChecked.value) {
    // 全部禁用
    mcpDisallowedTools.value = mcpTools.value.map(t => t.name)
  } else {
    // 全部启用
    mcpDisallowedTools.value = []
  }
}

// 保存工具权限
async function saveMcpTools() {
  if (!mcpToolsServerName.value) return
  mcpToolsSaving.value = true
  try {
    const res = await mcpAPI.saveToolPermissions(mcpToolsServerName.value, mcpDisallowedTools.value)
    if (res.success !== false) {
      message.success('工具权限已保存')
      // 保存后刷新工具列表
      mcpToolsLoading.value = true
      try {
        const refresh = await mcpAPI.listTools(mcpToolsServerName.value)
        if (refresh.success !== false) {
          const d = refresh.data || {}
          mcpTools.value = d.tools || []
          mcpDisallowedTools.value = d.disallowedTools || []
        }
      } catch (_) {}
      mcpToolsLoading.value = false
    } else {
      message.error(res.error || '保存失败')
    }
  } catch (e) {
    message.error('保存失败: ' + (e.message || ''))
  } finally {
    mcpToolsSaving.value = false
  }
}

// ==================== LSP 服务器管理 ====================
const lspLoading = ref(false)
const lspSaving = ref(false)
const lspServers = ref([])
const currentLspView = ref('list') // list | form
const lspEditName = ref(null)

const lspForm = reactive({
  name: '',
  scope: 'user',
  command: '',
  extensionsText: '',
  envText: '',
  enabled: true
})

const lspFormValid = computed(() => {
  if (!lspForm.name || !/^[a-zA-Z0-9_-]+$/.test(lspForm.name)) return false
  if (!lspForm.command) return false
  return true
})

// LSP 完全禁用状态（是否在 disabledTools 中）
const lspFullyDisabled = computed(() => {
  const tools = settings.security.disabledToolsText.split('\n').map(s => s.trim()).filter(s => s)
  return tools.includes('lsp')
})

const lspFullDisableSaving = ref(false)

async function toggleLspFullDisable() {
  const tools = settings.security.disabledToolsText.split('\n').map(s => s.trim()).filter(s => s)
  const newDisabledTools = tools.includes('lsp')
    ? tools.filter(t => t !== 'lsp')
    : [...tools, 'lsp']

  lspFullDisableSaving.value = true
  try {
    const res = await configAPI.updateConfig({ disabledTools: newDisabledTools })
    if (res.success !== false) {
      settings.security.disabledToolsText = newDisabledTools.join('\n')
      message.success(newDisabledTools.includes('lsp') ? 'LSP 已完全禁用' : 'LSP 已启用')
    } else {
      message.error(res.error || '操作失败')
    }
  } catch (e) {
    message.error('操作失败: ' + (e.message || ''))
  } finally {
    lspFullDisableSaving.value = false
  }
}

function resetLspForm() {
  lspForm.name = ''
  lspForm.scope = 'user'
  lspForm.command = ''
  lspForm.extensionsText = ''
  lspForm.envText = ''
  lspForm.enabled = true
}

function buildLspServerData() {
  const data = {
    name: lspForm.name,
    scope: lspForm.scope,
    command: lspForm.command,
    enabled: lspForm.enabled,
    extensions: lspForm.extensionsText
      ? lspForm.extensionsText.split(',').map(s => s.trim()).filter(s => s)
      : [],
    env: {}
  }
  lspForm.envText.split('\n').forEach(line => {
    const idx = line.indexOf('=')
    if (idx > 0) {
      const k = line.substring(0, idx).trim()
      const v = line.substring(idx + 1).trim()
      if (k) data.env[k] = v
    }
  })
  return data
}

async function loadLspServers() {
  lspLoading.value = true
  try {
    const res = await lspAPI.listServers()
    if (res.success !== false) {
      lspServers.value = res.data || []
    } else {
      message.error(res.error || '加载 LSP 服务器列表失败')
    }
  } catch (e) {
    console.error('加载 LSP 服务器列表失败:', e)
    message.error('加载失败: ' + (e.message || ''))
  } finally {
    lspLoading.value = false
  }
}

function openLspAdd() {
  lspEditName.value = null
  resetLspForm()
  currentLspView.value = 'form'
}

function openLspEdit(svr) {
  lspEditName.value = svr.name
  lspForm.name = svr.name
  lspForm.scope = svr.scope || 'user'
  lspForm.enabled = svr.enabled !== false
  lspForm.command = typeof svr.command === 'string' ? svr.command : (svr.command || []).join(' ')
  lspForm.extensionsText = (svr.extensions || []).join(', ')
  lspForm.envText = ''
  if (svr.env) {
    lspForm.envText = Object.entries(svr.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  }
  currentLspView.value = 'form'
}

function backToLspList() {
  currentLspView.value = 'list'
  loadLspServers()
}

async function saveLspServer() {
  if (!lspFormValid.value) {
    message.warning('请完善必填字段')
    return
  }
  lspSaving.value = true
  try {
    const data = buildLspServerData()
    let res
    if (lspEditName.value) {
      res = await lspAPI.updateServer(lspEditName.value, data)
    } else {
      res = await lspAPI.addServer(data)
    }
    if (res.success !== false) {
      message.success(lspEditName.value ? '已更新' : '已添加')
      backToLspList()
    } else {
      message.error(res.error || '保存失败')
    }
  } catch (e) {
    message.error('保存失败: ' + (e.message || ''))
  } finally {
    lspSaving.value = false
  }
}

async function deleteLspServer(name) {
  if (!confirm(`确定删除 LSP 服务器 "${name}"？`)) return
  try {
    const res = await lspAPI.removeServer(name)
    if (res.success !== false) {
      message.success('已删除')
      backToLspList()
    } else {
      message.error(res.error || '删除失败')
    }
  } catch (e) {
    message.error('删除失败: ' + (e.message || ''))
  }
}

async function toggleLspServer(svr) {
  try {
    const res = await lspAPI.toggleServer(svr.name, !svr.enabled)
    if (res.success !== false) {
      svr.enabled = !svr.enabled
    } else {
      message.error(res.error || '操作失败')
      loadLspServers()
    }
  } catch (e) {
    message.error('操作失败: ' + (e.message || ''))
    loadLspServers()
  }
}

// 初始化
onMounted(() => {
  loadSettings()
  loadOpenApiData()
  loadSystemFonts()
})

onBeforeUnmount(() => {
  stopMcpTunnelPolling()
})

// 加载系统提示词
const loadLoopraMd = async () => {
  promptLoading.value = true
  try {
    const res = await configAPI.getLoopraMd()
    if (res.success) {
      promptContent.value = res.data || ''
    } else {
      message.error(res.error || '加载失败')
    }
  } catch (err) {
    console.error('加载 loopra.md 失败:', err)
    message.error('加载失败: ' + (err.message || ''))
  } finally {
    promptLoading.value = false
  }
}

// 保存系统提示词
const saveLoopraMd = async () => {
  promptSaving.value = true
  try {
    const res = await configAPI.updateLoopraMd(promptContent.value)
    if (res.success) {
      message.success(res.data || '已保存')
    } else {
      message.error(res.error || '保存失败')
    }
  } catch (err) {
    console.error('保存 loopra.md 失败:', err)
    message.error('保存失败: ' + (err.message || ''))
  } finally {
    promptSaving.value = false
  }
}

// Tab 切换时加载系统提示词 — 追加到已有 watch(activeTab) 中
// 注意：该逻辑在已有 watch(activeTab) 内，无需重复
</script>

<style scoped>
/* 基础布局 */
.settings-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
}

.settings-page.market-only {
  width: 100%;
  height: 100%;
}

.market-only .settings-main {
  min-width: 0;
}

.market-only .settings-content {
  padding: 28px clamp(20px, 5vw, 72px);
}

.market-only .settings-section,
.market-only .section-card {
  width: 100%;
  max-width: none;
}

.market-only .skill-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

@media (min-width: 1150px) {
  .market-only .skill-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* 左侧导航 */
.settings-nav {
  width: 220px;
  min-height: 0;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
  padding: 16px 0;
}

.nav-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px 20px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.nav-items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--fg-2);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--r);
  cursor: pointer;
  transition: all var(--t);
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: var(--bg-3);
  color: var(--fg);
}

.nav-item.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}

.nav-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.8;
}

.nav-item.active .nav-icon {
  opacity: 1;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-badge {
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 600;
  background: var(--accent-btn);
  color: white;
  border-radius: 10px;
  line-height: 1;
}

/* 主内容区 */
.settings-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}

.header-title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
}

.header-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--fg-3);
}

.header-actions {
  display: flex;
  gap: 8px;
}

/* 设置内容区 */
.settings-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  padding: 24px;
}

.settings-section {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

/* 嵌入的工具/子代理/数据面板视图 */
.settings-embed {
  width: 100%;
}

.settings-embed-view {
  width: 100%;
  min-width: 0;
}

/* 模型渠道为定高布局（内部滚动），嵌入设置页时撑满内容区高度，否则左侧渠道栏随模型展开变高、不定高 */
.settings-embed.model-channels-embed {
  height: 100%;
}

.settings-embed-loading {
  display: grid;
  place-items: center;
  min-height: 240px;
  color: var(--fg-3);
  font-size: 13px;
}

/* OpenAPI 样式 */
.openapi-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.openapi-actions {
  display: flex;
  gap: 8px;
}

.openapi-search {
  margin: 16px;
}

.search-row {
  display: flex;
  gap: 8px;
}

.search-row .form-input {
  flex: 1;
}

.search-result {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
}

.result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 13px;
}

.result-loading, .result-empty {
  padding: 12px 0;
  color: var(--fg-3);
  font-size: 13px;
  text-align: center;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.result-item {
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
}

.ri-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.ri-name {
  font-weight: 600;
  font-size: 13px;
}

.ri-cat {
  font-size: 11px;
  color: var(--fg-3);
}

.ri-desc {
  font-size: 12px;
  color: var(--fg-2);
  margin-bottom: 4px;
}

.ri-endpoint {
  font-size: 11px;
  color: var(--fg-3);
}

.ri-endpoint code {
  background: var(--bg-3);
  padding: 2px 6px;
  border-radius: var(--r-sm);
}

.state-box {
  padding: 24px;
  text-align: center;
  color: var(--fg-3);
}

.state-box.error {
  color: var(--red);
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 8px;
}

.openapi-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.openapi-source-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
}

.openapi-source-card .card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}

.status-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.status-tag .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-tag.loaded {
  color: var(--green);
}

.status-tag.loaded .dot {
  background: var(--green);
}

.status-tag.error {
  color: var(--red);
}

.status-tag.error .dot {
  background: var(--red);
}

.status-tag.disabled {
  color: var(--fg-3);
}

.status-tag.disabled .dot {
  background: var(--fg-3);
}

.card-actions {
  display: flex;
  gap: 4px;
}

.btn-icon-xs {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--fg-2);
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: all var(--t);
}

.btn-icon-xs:hover {
  background: var(--bg-3);
  color: var(--fg);
}

.btn-icon-xs.danger:hover {
  background: var(--red-bg);
  color: var(--red);
}

.openapi-source-card .card-body {
  padding: 12px 16px;
}

.info-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-rows .row {
  display: flex;
  gap: 12px;
  font-size: 12px;
}

.info-rows .label {
  color: var(--fg-3);
  min-width: 40px;
}

.info-rows .val {
  color: var(--fg-2);
  word-break: break-all;
}

.info-rows .val code {
  background: var(--bg-3);
  padding: 2px 6px;
  border-radius: var(--r-sm);
  font-size: 11px;
}

.card-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--red-bg);
  color: var(--red);
  font-size: 12px;
  border-top: 1px solid var(--border);
}

/* 添加对话框 */
.add-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.add-dialog {
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.add-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

.add-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.add-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--border);
}

.field {
  margin-bottom: 16px;
}

.field label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.field .req {
  color: var(--red);
}

.field .hint {
  font-size: 11px;
  color: var(--fg-3);
  margin-top: 4px;
}

.header-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.header-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.header-row .form-input {
  flex: 1;
}

.auth-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.auth-tab {
  padding: 6px 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--t);
}

.auth-tab:hover {
  border-color: var(--accent);
}

.auth-tab.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
}

/* 设置卡片 */
.section-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  margin-bottom: 24px;
  overflow: hidden;
}

.section-card.danger-zone {
  border-color: var(--red);
}

.plugin-card {
  overflow: hidden;
}

.plugin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.plugin-list {
  padding: 0;
}

.plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 66px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.plugin-info {
  min-width: 0;
  flex: 1;
}

.plugin-title,
.plugin-runtime {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-title > span {
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}

.plugin-title code {
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg-3);
  color: var(--fg-3);
  font-size: 10px;
}

.plugin-meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  color: var(--fg-4);
  font-family: var(--mono);
  font-size: 10px;
}

.plugin-remark {
  margin: 4px 0 0;
  color: var(--fg-3);
  font-size: 12px;
  line-height: 1.45;
}

.plugin-meta span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-meta span:last-child {
  flex-shrink: 0;
  white-space: nowrap;
}

.plugin-runtime {
  flex-shrink: 0;
}

.plugin-instances {
  color: var(--fg-4);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.plugin-instances.active {
  color: var(--green);
}

.plugin-empty {
  padding: 32px 16px;
  color: var(--fg-4);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 720px) {
  .plugin-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .plugin-runtime {
    justify-content: space-between;
    width: 100%;
  }
}

.card-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}

.card-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}

.card-header p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--fg-3);
}

.card-body {
  padding: 12px;
}

/* 设置行 */
.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-info {
  flex: 1;
  min-width: 0;
}

.setting-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 4px;
}

.setting-hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.4;
}

.setting-control {
  flex-shrink: 0;
  min-width: 200px;
  display: flex;
  align-items: center;
}

/* 表单控件 */
.form-input,
.form-select,
.form-textarea {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  font-family: var(--sans);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  outline: none;
  transition: all var(--t);
}

.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-bg);
}

.form-input::placeholder,
.form-textarea::placeholder {
  color: var(--fg-4);
}

.form-textarea {
  resize: vertical;
  min-height: 80px;
}

/* 输入组 */
.input-group {
  display: flex;
  gap: 8px;
  width: 100%;
}

.input-group .form-input {
  flex: 1;
}

.h-full {
  height: 100%;
}

/* 带切换的输入 */
.input-with-toggle {
  position: relative;
  width: 100%;
}

.input-with-toggle .form-input {
  padding-right: 40px;
}

.toggle-visibility {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px;
  background: transparent;
  border: none;
  color: var(--fg-3);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color var(--t);
}

.toggle-visibility:hover {
  color: var(--fg);
}

/* 选择框 */
.select-wrapper {
  position: relative;
  width: 100%;
}

.form-select {
  appearance: none;
  padding-right: 32px;
  cursor: pointer;
}

.select-arrow {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-3);
  pointer-events: none;
}

/* 推理强度滑条 */
.reasoning-effort-control {
  min-width: 280px;
}

.reasoning-slider {
  width: 100%;
  padding: 10px 12px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: var(--r);
  background: linear-gradient(135deg, var(--bg), color-mix(in srgb, var(--accent) 7%, var(--bg)));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 12%, transparent), 0 6px 18px color-mix(in srgb, var(--accent) 10%, transparent);
}

.reasoning-slider-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  color: var(--fg-3);
  font-size: 11px;
  line-height: 1.2;
}

.reasoning-slider-value {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.reasoning-slider-track {
  position: relative;
  display: flex;
  align-items: center;
  height: 22px;
}

.reasoning-slider-input {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 6px;
  margin: 0;
  appearance: none;
  outline: none;
  cursor: pointer;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent) 0 var(--effort-progress), var(--bg-3) var(--effort-progress) 100%);
  box-shadow: inset 0 1px 2px color-mix(in srgb, #000000 18%, transparent);
}

.reasoning-slider-input:focus-visible {
  box-shadow: 0 0 0 3px var(--accent-bg), inset 0 1px 2px color-mix(in srgb, #000000 18%, transparent);
}

.reasoning-slider-input::-webkit-slider-thumb {
  width: 18px;
  height: 18px;
  appearance: none;
  border: 3px solid var(--bg);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent), 0 0 14px color-mix(in srgb, var(--accent) 70%, transparent);
  transition: transform var(--t), box-shadow var(--t);
}

.reasoning-slider-input:hover::-webkit-slider-thumb,
.reasoning-slider-input:focus-visible::-webkit-slider-thumb {
  transform: scale(1.15);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 18px color-mix(in srgb, var(--accent) 80%, transparent);
}

.reasoning-slider-input::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: 3px solid var(--bg);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent), 0 0 14px color-mix(in srgb, var(--accent) 70%, transparent);
}

.reasoning-slider-ticks {
  position: absolute;
  top: 50%;
  left: 7px;
  right: 7px;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  pointer-events: none;
  transform: translateY(-50%);
}

.reasoning-slider-ticks span {
  width: 4px;
  height: 4px;
  border: 1px solid var(--bg);
  border-radius: 50%;
  background: var(--fg-4);
  transition: background var(--t), transform var(--t);
}

.reasoning-slider-ticks span.active {
  background: var(--bg);
  transform: scale(1.18);
}

.reasoning-slider-levels {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  margin-top: 5px;
}

.reasoning-slider-levels button {
  min-width: 0;
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 10px;
  line-height: 1.2;
  transition: color var(--t), text-shadow var(--t), transform var(--t);
}

.reasoning-slider-levels button:hover {
  color: var(--fg-2);
  transform: translateY(-1px);
}

.reasoning-slider-levels button.active {
  color: var(--accent);
  font-weight: 700;
  text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 50%, transparent);
}

/* 主题选择 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  width: 100%;
}

.theme-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  cursor: pointer;
  transition: all var(--t);
}

.theme-option:hover {
  border-color: var(--accent);
}

.theme-option.active {
  border-color: var(--accent);
  background: var(--accent-bg);
}

.theme-preview {
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.theme-preview.gray {
  background: linear-gradient(135deg, #fafafa 50%, #d4d4d8 50%);
}

.theme-preview.dark {
  background: linear-gradient(135deg, #0c0c0c 50%, #1f1f1f 50%);
}

.theme-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-2);
}

.theme-option.active .theme-name {
  color: var(--accent);
  font-weight: 600;
}

/* 范围滑块 */
.range-control {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.form-range {
  flex: 1;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  outline: none;
  appearance: none;
  cursor: pointer;
}

.form-range::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  background: var(--accent);
  border-radius: 50%;
  cursor: pointer;
  transition: transform var(--t);
}

.form-range::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.range-value {
  min-width: 40px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  text-align: right;
}

/* 开关 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  cursor: pointer;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--border);
  border-radius: 12px;
  transition: all var(--t);
}

.toggle-slider:before {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: all var(--t);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--accent);
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.toggle-switch.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.toggle-switch.disabled .toggle-slider {
  background: var(--bg-3);
}

.toggle-switch.disabled input:checked + .toggle-slider {
  background: var(--fg-3);
}

.setting-status {
  margin-left: 8px;
  font-size: 12px;
  color: var(--fg-3);
}

/* 单选按钮组 */
.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.radio-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  cursor: pointer;
  transition: all var(--t);
}

.radio-option:hover {
  border-color: var(--accent);
}

.radio-option.active {
  border-color: var(--accent);
  background: var(--accent-bg);
}

.radio-option input[type="radio"] {
  margin-top: 2px;
  accent-color: var(--accent);
}

.radio-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}

.radio-desc {
  font-size: 11px;
  color: var(--fg-3);
}

.radio-option.active .radio-title {
  color: var(--accent);
}

/* 连接状态 */
.connection-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--r);
  font-size: 12px;
  font-weight: 600;
}

.connection-status.ok {
  background: var(--green-bg);
  color: var(--green);
}

.connection-status.error {
  background: var(--red-bg);
  color: var(--red);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--sans);
  border: 1px solid transparent;
  border-radius: var(--r);
  cursor: pointer;
  transition: all var(--t);
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent-btn);
  color: white;
  border-color: var(--accent-btn);
}

.btn-primary:hover:not(:disabled) {
  background: var(--blue-dark);
  border-color: var(--blue-dark);
}

.btn-secondary {
  background: var(--bg);
  color: var(--fg-2);
  border-color: var(--border);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-2);
  border-color: var(--accent);
  color: var(--accent);
}

.btn-ghost {
  background: transparent;
  color: var(--fg-2);
  border-color: transparent;
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-2);
  color: var(--fg);
}

.btn-danger {
  background: var(--red);
  color: white;
  border-color: var(--red);
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
  border-color: #b91c1c;
}

/* 动画 */
.animate-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 响应式设计 */
@media (max-width: 768px) {
  .settings-page {
    flex-direction: column;
  }

  .settings-nav {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 12px 0;
  }

  .nav-items {
    flex-direction: row;
    overflow-x: auto;
    padding: 0 12px;
    gap: 4px;
  }

  .nav-item {
    padding: 8px 12px;
    white-space: nowrap;
  }

  .settings-header {
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .setting-row {
    flex-direction: column;
    gap: 12px;
  }

  .setting-control {
    min-width: 100%;
  }

  .theme-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .input-group {
    flex-direction: column;
  }
}

/* ==================== MCP 服务器管理 ==================== */
.mcp-export-panel {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
}

.mcp-export-header,
.mcp-export-footer,
.mcp-export-selection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.mcp-export-header h4 {
  margin: 0 0 4px;
  font-size: 14px;
}

.mcp-export-header p,
.mcp-export-hint {
  margin: 0;
  color: var(--fg-3);
  font-size: 12px;
}

.mcp-export-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 0 4px;
  color: var(--fg-3);
  font-size: 12px;
}

.mcp-export-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  margin-top: 16px;
}

.mcp-export-field label,
.mcp-export-selection-head label {
  display: block;
  margin-bottom: 6px;
  color: var(--fg-2);
  font-size: 12px;
  font-weight: 600;
}

.mcp-export-selection {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.mcp-export-selection-head > div:first-child span {
  color: var(--fg-3);
  font-size: 11px;
}

.mcp-export-modes {
  display: flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--r);
}

.mcp-export-mode {
  padding: 6px 10px;
  border: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg-2);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 11px;
}

.mcp-export-mode:last-child {
  border-right: 0;
}

.mcp-export-mode.active {
  background: var(--accent);
  color: white;
}

.mcp-export-tools {
  max-height: 260px;
  margin-top: 10px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r);
}

.mcp-export-tool-actions {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.mcp-export-tool {
  display: grid;
  grid-template-columns: auto minmax(110px, 0.8fr) minmax(0, 2fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}

.mcp-export-tool:last-child {
  border-bottom: 0;
}

.mcp-export-tool.disabled {
  opacity: 0.55;
}

.mcp-export-tool-name {
  overflow: hidden;
  color: var(--fg-2);
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-export-tool-description {
  overflow: hidden;
  color: var(--fg-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-export-tool-state {
  color: var(--fg-3);
  white-space: nowrap;
}

.mcp-export-footer {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.mcp-export-endpoint {
  min-width: 0;
  color: var(--fg-3);
  font-size: 11px;
}

.mcp-export-endpoint code {
  display: inline-block;
  max-width: 380px;
  margin-left: 4px;
  overflow: hidden;
  color: var(--accent);
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.mcp-export-hint {
  margin-top: 10px;
}

.mcp-tunnel-panel {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
}

.mcp-tunnel-header,
.mcp-tunnel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.mcp-tunnel-header h4 {
  margin: 0 0 4px;
  font-size: 14px;
}

.mcp-tunnel-header p,
.mcp-tunnel-hint {
  margin: 0;
  color: var(--fg-3);
  font-size: 12px;
}

.mcp-tunnel-badge {
  flex-shrink: 0;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--fg-3);
  font-size: 11px;
}

.mcp-tunnel-badge.is-running {
  background: var(--accent-bg);
  color: var(--accent);
}

.mcp-tunnel-badge.is-error {
  background: var(--red-bg);
  color: var(--red);
}

.mcp-tunnel-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 0 4px;
  color: var(--fg-3);
  font-size: 12px;
}

.mcp-tunnel-warning,
.mcp-tunnel-error {
  margin-top: 14px;
  padding: 10px;
  font-size: 12px;
}

.mcp-tunnel-warning {
  background: var(--accent-bg);
  color: var(--fg-2);
}

.mcp-tunnel-warning a {
  margin-left: 4px;
  color: var(--accent);
}

.mcp-tunnel-error {
  background: var(--red-bg);
  color: var(--red);
}

.mcp-tunnel-fields {
  margin-top: 14px;
}

.mcp-tunnel-field label {
  display: block;
  margin-bottom: 6px;
  color: var(--fg-2);
  font-size: 12px;
  font-weight: 600;
}

.mcp-tunnel-footer {
  align-items: flex-end;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.mcp-tunnel-url {
  min-width: 0;
  color: var(--fg-3);
  font-size: 11px;
}

.mcp-tunnel-url span {
  display: block;
  margin-bottom: 4px;
}

.mcp-tunnel-url code {
  display: inline-block;
  max-width: 500px;
  overflow: hidden;
  color: var(--accent);
  text-overflow: ellipsis;
  vertical-align: middle;
  white-space: nowrap;
}

.mcp-tunnel-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.mcp-tunnel-hint {
  margin-top: 10px;
}

.mcp-card .card-body {
  min-height: 200px;
  margin: 12px;
}

.mcp-list-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  width: 100%;
  gap: 16px;
}

.mcp-list-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.mcp-list-header p {
  margin: 0;
  font-size: 12px;
  color: var(--fg-3);
}

.mcp-state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 2rem;
  text-align: center;
  gap: 12px;
  color: var(--fg-3);
}

.mcp-state-box h4 {
  margin: 0;
  font-size: 16px;
  color: var(--fg-2);
}

.mcp-state-box p {
  margin: 0;
  font-size: 13px;
  max-width: 360px;
}

.mcp-server-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mcp-server-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  cursor: pointer;
  transition: all var(--t);
}

.mcp-server-item:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
}

.mcp-item-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
  background: var(--bg-2);
  color: var(--fg-2);
  border: 1px solid var(--border);
}

.mcp-item-icon.type-stdio {
  background: #e0f2fe;
  color: #0369a1;
  border-color: #7dd3fc;
}

.mcp-item-icon.type-sse {
  background: #dcfce7;
  color: #15803d;
  border-color: #86efac;
}

.mcp-item-icon.type-streamable {
  background: #fef3c7;
  color: #a16207;
  border-color: #fcd34d;
}

.mcp-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.mcp-item-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--fg);
}

.mcp-type-tag {
  display: inline-block;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 4px;
  background: var(--bg-2);
  color: var(--fg-3);
  border: 1px solid var(--border);
  font-weight: 500;
}

.mcp-item-detail {
  width: 100%;
  font-size: 11px;
  color: var(--fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.mcp-form-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mcp-form-header h3 {
  margin: 0;
  font-size: 15px;
}

.mcp-field {
  margin-bottom: 16px;
}

.mcp-field > label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--fg-2);
}

.mcp-field .req {
  color: var(--red);
}

.mcp-hint {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--fg-3);
}

.mcp-type-toggle {
  display: flex;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
  width: fit-content;
}

.mcp-type-toggle .type-btn {
  padding: 7px 16px;
  font-size: 12px;
  font-weight: 600;
  border: none;
  background: var(--bg);
  color: var(--fg-2);
  cursor: pointer;
  transition: all var(--t);
  font-family: var(--sans);
}

.mcp-type-toggle .type-btn:not(:last-child) {
  border-right: 1px solid var(--border);
}

.mcp-type-toggle .type-btn.active {
  background: var(--accent);
  color: white;
}

.mcp-type-toggle .type-btn:hover:not(.active) {
  background: var(--bg-2);
}

.mcp-check-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: var(--r);
  font-size: 12px;
  font-weight: 500;
}

.mcp-check-result.ok {
  background: var(--green-bg);
  color: var(--green);
}

.mcp-check-result.error {
  background: var(--red-bg);
  color: var(--red);
}

.mcp-form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.mcp-tools-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mcp-tools-header h3 {
  margin: 0;
  font-size: 15px;
}

.mcp-tools-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  margin-bottom: 12px;
}

.mcp-tools-count {
  flex: 1;
  font-size: 12px;
  color: var(--fg-3);
}

.mcp-tools-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcp-tool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  transition: all var(--t);
}

.mcp-tool-item:hover {
  border-color: var(--accent);
}

.mcp-tool-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 11px;
  flex-shrink: 0;
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.mcp-tool-info {
  flex: 1;
  min-width: 0;
}

.mcp-tool-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  font-family: var(--mono, monospace);
}

.mcp-tool-desc {
  font-size: 11px;
  color: var(--fg-3);
  margin-top: 2px;
}

.mcp-checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  user-select: none;
}

.mcp-checkbox {
  display: none;
}

.mcp-checkbox-custom {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--t);
  flex-shrink: 0;
}

.mcp-checkbox:checked + .mcp-checkbox-custom {
  background: var(--accent);
  border-color: var(--accent);
}

.mcp-checkbox:checked + .mcp-checkbox-custom::after {
  content: '';
  width: 5px;
  height: 9px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
  margin-top: -1px;
}

.mcp-checkbox-label:hover .mcp-checkbox-custom {
  border-color: var(--accent);
}

.form-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  font-family: var(--mono, monospace);
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--bg);
  color: var(--fg);
  resize: vertical;
  outline: none;
  transition: border-color var(--t);
  box-sizing: border-box;
}

.form-textarea:focus {
  border-color: var(--accent);
}

/* ==================== 技能市场 ==================== */
.installed-skills-section {
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 12px;
  margin-bottom: 14px;
  background: var(--bg-2, var(--bg));
}

.installed-skills-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.installed-skills-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
  cursor: pointer;
  user-select: none;
}

.installed-skills-toggle:hover .installed-skills-title {
  color: var(--accent);
}

.installed-skills-chevron {
  flex-shrink: 0;
  color: var(--fg-3);
  transition: transform var(--t);
}

.installed-skills-chevron.collapsed {
  transform: rotate(-90deg);
}

.installed-skills-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}

.installed-skills-count {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.installed-skills-sub {
  font-size: 11px;
  color: var(--fg-3);
}

.installed-skills-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px 0 10px;
  color: var(--fg-3);
  font-size: 12px;
  text-align: center;
}

.skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  transition: all var(--t);
}

.skill-item:hover {
  border-color: var(--accent);
}

.skill-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
  flex-shrink: 0;
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  display: flex;
  align-items: center;
  gap: 6px;
}

.skill-installed-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid var(--accent);
  white-space: nowrap;
}

.skill-desc {
  font-size: 12px;
  color: var(--fg-3);
  margin-top: 2px;
  line-height: 1.4;
}

.skill-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--fg-3);
}

.skill-actions {
  flex-shrink: 0;
}

.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  text-align: center;
  color: var(--fg-3);
  font-size: 13px;
}

/* ==================== 远端模型弹窗 ==================== */
.remote-models-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}

.remote-models-dialog {
  width: min(600px, 92vw);
  max-height: 80vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

[data-theme="dark"] .remote-models-dialog {
  background: var(--bg-2);
}

.remote-models-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  flex-shrink: 0;
}

.remote-models-head .remote-models-count {
  flex: 1;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-3);
}

.remote-models-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
  min-height: 200px;
}

.remote-models-loading,
.remote-models-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  color: var(--fg-3);
  font-size: 13px;
}

.remote-models-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.remote-check-all {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  user-select: none;
}

.remote-check-all input[type="checkbox"] {
  cursor: pointer;
}

.remote-selected-count {
  flex: 1;
  font-size: 12px;
  color: var(--fg-3);
}

.remote-models-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 360px;
  overflow-y: auto;
}

.remote-model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--r);
  cursor: pointer;
  transition: background 0.12s;
  font-size: 13px;
}

.remote-model-item:hover {
  background: var(--bg-3);
}

.remote-model-item.checked {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}

.remote-model-item input[type="checkbox"] {
  pointer-events: none;
  cursor: pointer;
}

.remote-model-name {
  flex: 1;
  font-family: var(--mono, monospace);
  font-size: 13px;
}

.remote-model-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--primary);
  color: #fff;
  flex-shrink: 0;
}

.remote-models-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.remote-models-foot .btn {
  min-width: 100px;
}

/* ==================== 自动填入配置弹窗 ==================== */
.auto-fill-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}

.auto-fill-dialog {
  width: min(460px, 92vw);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

[data-theme="dark"] .auto-fill-dialog {
  background: var(--bg-2);
}

.auto-fill-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
}

.auto-fill-head .btn-icon-xs {
  margin-left: auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-3);
  transition: all var(--t);
  font-size: 16px;
  background: none;
  border: none;
  cursor: pointer;
}
.auto-fill-head .btn-icon-xs:hover {
  background: var(--bg-2);
  color: var(--fg);
}

.auto-fill-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auto-fill-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auto-fill-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-2);
}

.auto-fill-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.auto-fill-foot .btn {
  min-width: 100px;
}

/* 模型价格表格 */
.price-table-wrap {
  overflow-x: auto;
}

.price-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.price-table th,
.price-table td {
  padding: 8px 6px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.price-table thead th {
  font-weight: 600;
  color: var(--fg-2);
  white-space: nowrap;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.price-th-model {
  min-width: 140px;
}

.price-th-num {
  min-width: 80px;
  text-align: right;
}

.price-th-action {
  width: 36px;
}

.price-td-model {
  vertical-align: middle;
}

.price-model-input {
  width: 100%;
  min-width: 120px;
  font-size: 13px;
  padding: 4px 8px;
}

.price-td-num {
  vertical-align: middle;
}

.price-num-input {
  width: 75px;
  text-align: right;
  font-size: 13px;
  padding: 4px 6px;
  -moz-appearance: textfield;
}

.price-num-input::-webkit-inner-spin-button,
.price-num-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.price-td-action {
  text-align: center;
  vertical-align: middle;
}

.price-empty {
  text-align: center;
  padding: 24px 0;
  color: var(--fg-3);
  font-size: 13px;
}

.price-empty p {
  margin: 0;
}

.price-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

/* ==================== 关于页面 ==================== */
.about-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.about-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.about-label {
  min-width: 80px;
  font-size: 13px;
  color: var(--fg-3);
  flex-shrink: 0;
  padding-top: 2px;
}

.about-value {
  font-size: 13px;
  color: var(--fg);
  word-break: break-all;
}

.about-value.version-number {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 15px;
  color: var(--accent);
}

.about-value.has-update {
  color: #ef4444;
}

.about-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}

.about-link:hover {
  text-decoration: underline;
}

.about-notes {
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.6;
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-2);
  padding: 12px 16px;
  border-radius: var(--r);
  flex: 1;
  word-break: break-word;
}

.about-notes h1,
.about-notes h2,
.about-notes h3,
.about-notes h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 12px 0 6px;
  color: var(--fg);
}
.about-notes h1:first-child,
.about-notes h2:first-child,
.about-notes h3:first-child,
.about-notes h4:first-child {
  margin-top: 0;
}

.about-notes p {
  margin: 6px 0;
}

.about-notes ul,
.about-notes ol {
  margin: 4px 0;
  padding-left: 20px;
}

.about-notes li {
  margin: 2px 0;
}

.about-notes code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-3);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--accent);
}

.about-notes pre {
  background: var(--bg-3);
  border-radius: var(--r);
  padding: 10px 14px;
  overflow-x: auto;
  margin: 8px 0;
}

.about-notes pre code {
  background: none;
  padding: 0;
  color: var(--fg);
}

.about-notes a {
  color: var(--accent);
  text-decoration: none;
}
.about-notes a:hover {
  text-decoration: underline;
}

.about-notes strong {
  color: var(--fg);
  font-weight: 600;
}

.about-notes blockquote {
  border-left: 3px solid var(--accent);
  padding: 4px 12px;
  margin: 8px 0;
  background: var(--bg-3);
  border-radius: 0 var(--r) var(--r) 0;
  color: var(--fg-3);
}

.update-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.about-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  align-items: center;
}

.auto-update-tip {
  font-size: 12px;
  color: var(--fg-3);
  margin-left: 4px;
}

.about-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--r);
  font-size: 12px;
  color: #ef4444;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.animate-spin {
  animation: spin 1s linear infinite;
}

/* ==================== 更新/重装 弹窗 ==================== */
.update-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.update-modal {
  width: 600px;
  max-width: 90vw;
  background: var(--bg);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.update-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.update-modal-body {
  padding: 20px;
}

.update-modal-desc {
  font-size: 13px;
  color: var(--fg-3);
  margin: 0 0 16px;
}

.update-platform {
  margin-bottom: 16px;
}

.update-platform:last-child {
  margin-bottom: 0;
}

.update-platform-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  margin-bottom: 6px;
}

.update-code-block {
  display: flex;
  align-items: center;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 10px 12px;
  gap: 8px;
}

.update-code-block code {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg);
  word-break: break-all;
  line-height: 1.5;
  user-select: all;
}

.update-copy-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-3);
  transition: all var(--t);
  cursor: pointer;
  border: none;
  background: transparent;
}

.update-copy-btn:hover {
  background: var(--bg-3);
  color: var(--accent);
}

.update-modal-foot {
  display: flex;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

[data-theme="dark"] .update-modal-mask {
  background: rgba(0, 0, 0, 0.6);
}

[data-theme="dark"] .update-modal {
  border: 1px solid var(--border);
}

/* 提示块样式 */
.setting-hint-block {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 12px 16px;
  width: 100%;
}

.setting-hint-block p {
  margin: 0 0 6px 0;
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.5;
}

.setting-hint-block p:last-child {
  margin-bottom: 0;
}

.setting-hint-block code {
  background: var(--bg-3);
  padding: 2px 6px;
  border-radius: var(--r-sm);
  font-size: 11px;
  font-family: var(--mono);
}

/* ── 宠物设置 ── */
.pets-loading, .pets-error, .pets-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--fg-3);
}
.pets-error {
  color: var(--danger);
}
.pets-empty .empty-icon {
  margin-bottom: 12px;
}
.pets-empty .hint {
  font-size: 12px;
  margin-top: 8px;
  color: var(--fg-3);
}
.pets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
}
.pet-card {
  position: relative;
  background: var(--bg);
  border: 2px solid var(--border);
  border-radius: var(--r-lg);
  padding: 16px;
  cursor: pointer;
  transition: all var(--t);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}
.pet-card:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.pet-card.pet-active {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.pet-card.pet-no-spritesheet {
  opacity: 0.6;
  cursor: default;
}
.pet-preview {
  width: 96px;
  height: 104px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--r);
  pointer-events: none; /* 阻止 PetSprite 自身的单击改大小 */
}
.pet-no-sprite-placeholder {
  width: 96px;
  height: 104px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pet-info {
  flex: 1;
  min-width: 0;
}
.pet-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 4px;
}
.pet-desc {
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pet-check {
  position: absolute;
  top: 8px;
  right: 8px;
}

.pet-delete-btn {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--r);
  background: rgba(0,0,0,0.5);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--t);
  z-index: 2;
}
.pet-card:hover .pet-delete-btn {
  opacity: 1;
}
.pet-delete-btn:hover {
  background: var(--danger);
}

/* 顶部操作栏 — 与描述同行 */
.card-header-row {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.pet-top-bar {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 无宠物时的初始化区域 */
.pet-init-inline {
  margin-top: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
}
.pet-init-inline .pet-init-hint {
  font-size: 12px;
  color: var(--fg-3);
}

/* ======== 系统提示词编辑器 ======== */
.prompt-editor {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--mono, 'JetBrains Mono Variable', monospace);
  font-size: 13px;
  line-height: 1.6;
  padding: 16px;
  tab-size: 2;
}
.prompt-editor::placeholder {
  color: var(--fg-3);
}
.prompt-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 4px;
}
.prompt-info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-3);
}

@media (max-width: 720px) {
  .mcp-export-fields {
    grid-template-columns: 1fr;
  }

  .mcp-export-selection-head,
  .mcp-export-footer,
  .mcp-tunnel-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .mcp-export-tool {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .mcp-export-tool-description {
    display: none;
  }

  .mcp-tunnel-actions {
    justify-content: flex-end;
    width: 100%;
  }

  .mcp-tunnel-url code {
    max-width: 100%;
  }
}
</style>
