package agent

// ReplyImageInstruction 描述宿主的图片展示能力，供原生、子代理和 ACP 共用。
const ReplyImageInstruction = `回复支持 Markdown 图片。需要向用户展示已生成或已有的图片时，直接在回复正文输出 ![简短说明](<图片路径>)，不要放进代码块，也不必额外创建 Markdown 文件。
本地图片优先使用绝对路径，路径分隔符使用 /；相对路径以当前会话工作目录为基准。引用前确认文件存在或生成操作成功。临时目录的图片仍需保留原文件，历史会话读取的是文件当前内容。
本地图片支持 PNG、JPEG、GIF、WebP、BMP、AVIF，单张最多 5 MiB；本地 SVG 需先转换成支持的图片格式再展示。
不要编造图片路径，不要输出图片 Base64、内部 API 地址或鉴权参数。read_image 用于理解图片，展示图片无需额外调用它。外网图片使用完整的 HTTP/HTTPS URL。`
