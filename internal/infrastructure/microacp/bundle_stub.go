//go:build !(windows && (amd64 || arm64)) && !(darwin && !ios && (amd64 || arm64)) && !(linux && !android && (amd64 || arm64))

package microacp

var payload []byte
