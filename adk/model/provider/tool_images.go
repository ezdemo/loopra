package provider

import (
	"fmt"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// Tool results remain adjacent to their calls. Media follows the entire batch as
// user content because Chat Completions tool messages only accept text.
func expandToolImages(req *model.LLMRequest, imageInput bool) *model.LLMRequest {
	if req == nil || !imageInput {
		return req
	}
	var contents []*genai.Content
	changed := false
	for _, content := range req.Contents {
		contents = append(contents, content)
		if content == nil {
			continue
		}
		for _, part := range content.Parts {
			if part == nil || part.FunctionResponse == nil {
				continue
			}
			response := part.FunctionResponse
			var images []*genai.Part
			for _, media := range response.Parts {
				if media == nil {
					continue
				}
				if media.InlineData != nil {
					images = append(images, &genai.Part{InlineData: &genai.Blob{MIMEType: media.InlineData.MIMEType, Data: media.InlineData.Data}})
				}
				if media.FileData != nil {
					images = append(images, &genai.Part{FileData: &genai.FileData{MIMEType: media.FileData.MIMEType, FileURI: media.FileData.FileURI}})
				}
			}
			if len(images) > 0 {
				parts := []*genai.Part{{Text: fmt.Sprintf("图片来自工具 %s（调用 %s）。", response.Name, response.ID)}}
				parts = append(parts, images...)
				contents = append(contents, &genai.Content{Role: genai.RoleUser, Parts: parts})
				changed = true
			}
		}
	}
	if !changed {
		return req
	}
	copy := *req
	copy.Contents = contents
	return &copy
}
