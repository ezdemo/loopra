// Package appicon 是打进桌面程序里的 Loopra 标志。
package appicon

import _ "embed"

// PNG 是 512×512 的 Loopra 标志，和 web/public/icon-512.png 同一份。
//
//go:embed icon-512.png
var PNG []byte
