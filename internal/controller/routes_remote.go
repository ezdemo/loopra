package controller

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/ezdemo/looprax/internal/service/almarelay"
	qrcode "github.com/skip2/go-qrcode"
)

func (s *Controller) registerRemoteRoutes(api *apiRouter) {
	readRoute(api, "/mobile/handshake", s.action((*Controller).mobileHandshake))
	readRoute(api, "/remote/relay", s.action((*Controller).relayStatus))
	api.PUT("/remote/relay", s.action((*Controller).relayUpdate))
	api.POST("/remote/relay/reset-pairing", s.action((*Controller).relayResetPairing))
}

func (s *Controller) relayStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	status := almarelay.Status{State: "disabled"}
	if s.remoteRelay != nil {
		status = s.remoteRelay.Status()
	}
	s.writeRelayStatus(w, status)
}

func (s *Controller) relayUpdate(w http.ResponseWriter, r *http.Request) {
	if s.remoteRelay == nil {
		writeFail(w, http.StatusServiceUnavailable, "远程访问服务未启用")
		return
	}
	var update *almarelay.Update
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&update); err != nil || update == nil {
		writeFailReason(w, http.StatusBadRequest, "远程访问配置格式不正确", "invalid_remote_config")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeFailReason(w, http.StatusBadRequest, "远程访问配置格式不正确", "invalid_remote_config")
		return
	}
	status, err := s.remoteRelay.Update(*update)
	if err != nil {
		if errors.Is(err, almarelay.ErrConfigStorage) {
			writeFailReason(w, http.StatusInternalServerError, "保存远程访问配置失败", "remote_config_failed")
			return
		}
		writeFailReason(w, http.StatusBadRequest, err.Error(), "remote_config_failed")
		return
	}
	s.writeRelayStatus(w, status)
}

func (s *Controller) relayResetPairing(w http.ResponseWriter, r *http.Request) {
	if s.remoteRelay == nil {
		writeFail(w, http.StatusServiceUnavailable, "远程访问服务未启用")
		return
	}
	status, err := s.remoteRelay.ResetPairing()
	if err != nil {
		writeFailReason(w, http.StatusInternalServerError, err.Error(), "remote_pairing_failed")
		return
	}
	s.writeRelayStatus(w, status)
}

func (s *Controller) writeRelayStatus(w http.ResponseWriter, status almarelay.Status) {
	w.Header().Set("Cache-Control", "no-store")
	response := struct {
		almarelay.Status
		QRCode string `json:"qrCode,omitempty"`
	}{Status: status}
	if status.PairingLink != "" {
		png, err := qrcode.Encode(status.PairingLink, qrcode.Medium, 320)
		if err != nil {
			writeFail(w, http.StatusInternalServerError, "生成配对二维码失败")
			return
		}
		response.QRCode = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	}
	writeOK(w, http.StatusOK, response)
}
