//go:build darwin && !ios && arm64

package microacp

import _ "embed"

//go:embed assets/darwin_arm64/micro-acp.gz
var payload []byte
