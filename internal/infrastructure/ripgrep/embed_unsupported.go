//go:build !(windows && (amd64 || arm64 || 386)) && !(darwin && (amd64 || arm64)) && !(linux && (amd64 || arm64 || s390x || (arm && arm.7)))

package ripgrep

var embeddedGzip []byte

const binarySHA256 = ""
