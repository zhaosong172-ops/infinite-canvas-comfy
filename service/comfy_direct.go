package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

// directComfyWorkflow executes against the configured ComfyUI URL.  It is the
// desktop-friendly path: no bridge process or server-side queue is required.
func directComfyWorkflow(ctx context.Context, taskID, userID string, channel model.ModelChannel, entry model.WorkflowEntry, input WorkflowRunInput, overrides []WorkflowOverride) {
	if err := markRunningHubTask(userID, taskID, "comfy-direct"); err != nil {
		_ = finishWorkflowTask(taskID, "failed", nil, err.Error())
		return
	}
	capture := &AICallLogInput{Endpoint: strings.TrimRight(channel.ComfyURL, "/") + "/prompt", Method: http.MethodPost}
	workflow, err := directComfyWorkflowJSON(entry.WorkflowJSON)
	if err == nil {
		err = directComfyApplyMedia(ctx, strings.TrimRight(channel.ComfyURL, "/"), channel.APIKey, workflow, input, overrides)
	}
	if err == nil {
		err = directComfyApplyOverrides(workflow, overrides)
	}
	if err == nil {
		directNormalizeMiniMaxH3Prompt(workflow)
		err = directAdaptH3VideoOutput(ctx, channel, workflow)
	}
	if err != nil {
		_ = finishWorkflowTask(taskID, "failed", nil, err.Error(), capture)
		return
	}
	body, _ := json.Marshal(map[string]any{"prompt": workflow, "client_id": "infinite-canvas-" + userID})
	capture.RequestBody = string(workflowLogJSON(string(body), channel.APIKey))
	promptID, err := directComfyRequest(ctx, channel, http.MethodPost, "/prompt", body)
	if err != nil {
		_ = finishWorkflowTask(taskID, "failed", nil, err.Error(), capture)
		return
	}
	capture.ResponseBody = fmt.Sprintf(`{"prompt_id":%q}`, promptID)
	urls, err := directComfyWait(ctx, channel, promptID)
	if err != nil {
		_ = finishWorkflowTask(taskID, "failed", nil, err.Error(), capture)
		return
	}
	_ = finishWorkflowTask(taskID, "completed", urls, "", capture)
}

func directNormalizeMiniMaxH3Prompt(workflow map[string]any) {
	for _, raw := range workflow {
		node, ok := raw.(map[string]any)
		if !ok || stringValue(node["class_type"]) != "MiniMaxH3ReferenceToVideo" {
			continue
		}
		inputs, _ := node["inputs"].(map[string]any)
		prompt := strings.TrimSpace(stringValue(inputs["prompt"]))
		if prompt == "" {
			return
		}
		tags := make([]string, 0, 3)
		if count := directActiveH3Slots(inputs, "ref_images.ref_image_"); count > 0 && !strings.Contains(strings.ToLower(prompt), "<picture ") {
			tags = append(tags, directH3Tags("Picture", count)... )
		}
		if count := directActiveH3Slots(inputs, "ref_videos.ref_video_"); count > 0 && !strings.Contains(strings.ToLower(prompt), "<video ") {
			tags = append(tags, directH3Tags("Video", count)... )
		}
		if count := directActiveH3Slots(inputs, "ref_audios.ref_audio_"); count > 0 && !strings.Contains(strings.ToLower(prompt), "<audio ") {
			tags = append(tags, directH3Tags("Audio", count)... )
		}
		if len(tags) > 0 {
			inputs["prompt"] = strings.Join(tags, " ") + " " + prompt
		}
		return
	}
}

func directActiveH3Slots(inputs map[string]any, prefix string) int {
	count := 0
	for key, value := range inputs {
		if strings.HasPrefix(key, prefix) {
			if _, ok := value.([]any); ok {
				count++
			}
		}
	}
	return count
}

func directH3Tags(label string, count int) []string {
	tags := make([]string, 0, count)
	for i := 1; i <= count; i++ {
		tags = append(tags, fmt.Sprintf("<%s %d>", label, i))
	}
	return tags
}

func directAdaptH3VideoOutput(ctx context.Context, channel model.ModelChannel, workflow map[string]any) error {
	needsAdapter := false
	for _, raw := range workflow {
		node, ok := raw.(map[string]any)
		if ok && stringValue(node["class_type"]) == "H3SaveVideo" {
			needsAdapter = true
			break
		}
	}
	if !needsAdapter {
		return nil
	}
	endpoint := strings.TrimRight(strings.TrimSpace(channel.ComfyURL), "/") + "/object_info"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	if key := strings.TrimSpace(channel.APIKey); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		return fmt.Errorf("检查 H3 视频编码器失败：%w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("读取 ComfyUI 节点定义失败：HTTP %d", response.StatusCode)
	}
	var info map[string]any
	if err := json.Unmarshal(data, &info); err != nil {
		return errors.New("ComfyUI 节点定义不是有效 JSON")
	}
	if _, ok := info["VHS_VideoCombine"]; !ok {
		return errors.New("云端没有可用的 CPU 视频编码节点 VHS_VideoCombine；请安装 VideoHelperSuite")
	}
	for nodeID, raw := range workflow {
		node, ok := raw.(map[string]any)
		if !ok || stringValue(node["class_type"]) != "H3SaveVideo" {
			continue
		}
		oldInputs, _ := node["inputs"].(map[string]any)
		crf := 18
		switch strings.ToLower(stringValue(oldInputs["quality"])) {
		case "max":
			crf = 14
		case "archive":
			crf = 10
		}
		inputs := map[string]any{"images": oldInputs["images"], "frame_rate": firstWorkflowValue(oldInputs["fps"], 24), "loop_count": 0, "filename_prefix": firstWorkflowValue(oldInputs["filename_prefix"], "InfiniteCanvas/H3"), "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": crf, "save_metadata": false, "trim_to_audio": false, "pingpong": false, "save_output": true}
		if audio := oldInputs["audio"]; audio != nil {
			inputs["audio"] = audio
		}
		replacement := map[string]any{"class_type": "VHS_VideoCombine", "inputs": inputs}
		if meta, ok := node["_meta"]; ok {
			replacement["_meta"] = meta
		}
		workflow[nodeID] = replacement
	}
	return nil
}

func directComfyWorkflowJSON(source map[string]any) (map[string]any, error) {
	if len(source) == 0 {
		return nil, errors.New("ComfyUI 工作流 JSON 为空，请先导入 API JSON")
	}
	raw, err := json.Marshal(source)
	if err != nil {
		return nil, err
	}
	var workflow map[string]any
	if err := json.Unmarshal(raw, &workflow); err != nil {
		return nil, err
	}
	return workflow, nil
}

func directComfyRequest(ctx context.Context, channel model.ModelChannel, method, path string, body []byte) (string, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(channel.ComfyURL), "/") + path
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return "", err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key := strings.TrimSpace(channel.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{Timeout: 15 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("ComfyUI 请求失败：%w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("ComfyUI %s 返回 %d：%s", path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("ComfyUI 响应不是 JSON：%w", err)
	}
	if id := stringValue(payload["prompt_id"]); id != "" {
		return id, nil
	}
	return "", errors.New("ComfyUI 未返回 prompt_id")
}

func directComfyWait(ctx context.Context, channel model.ModelChannel, promptID string) ([]string, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(channel.ComfyURL), "/") + "/history/" + url.PathEscape(promptID)
	client := &http.Client{Timeout: 30 * time.Second}
	deadline := time.Now().Add(workflowTaskTimeout)
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		if key := strings.TrimSpace(channel.APIKey); key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		resp, err := client.Do(req)
		if err == nil {
			data, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
			resp.Body.Close()
			if readErr == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
				var all map[string]any
				if json.Unmarshal(data, &all) == nil {
					if history, ok := all[promptID].(map[string]any); ok {
						if status, _ := history["status"].(map[string]any); status != nil {
							statusText := strings.ToLower(firstNonEmpty(stringValue(status["status_str"]), stringValue(status["status"])))
							if statusText == "error" || statusText == "failed" {
								return nil, fmt.Errorf("ComfyUI 工作流执行失败：%s", stringValue(status["messages"]))
							}
						}
						if urls := directComfyOutputURLs(channel.ComfyURL, history["outputs"]); len(urls) > 0 {
							return urls, nil
						}
					}
				}
			}
		}
		timer := time.NewTimer(1500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, errors.New("ComfyUI 任务超时")
}

func directComfyOutputURLs(base string, raw any) []string {
	result := []string{}
	var walk func(any)
	walk = func(value any) {
		switch item := value.(type) {
		case map[string]any:
			filename := stringValue(item["filename"])
			if filename != "" {
				values := url.Values{}
				values.Set("filename", filename)
				if subfolder := stringValue(item["subfolder"]); subfolder != "" {
					values.Set("subfolder", subfolder)
				}
				if typ := stringValue(item["type"]); typ != "" {
					values.Set("type", typ)
				}
				result = append(result, strings.TrimRight(base, "/")+"/view?"+values.Encode())
				return
			}
			for _, child := range item {
				walk(child)
			}
		case []any:
			for _, child := range item {
				walk(child)
			}
		}
	}
	walk(raw)
	return result
}

func directComfyApplyOverrides(workflow map[string]any, overrides []WorkflowOverride) error {
	for _, override := range overrides {
		node, ok := workflow[override.NodeID].(map[string]any)
		if !ok {
			return fmt.Errorf("工作流缺少节点 %s", override.NodeID)
		}
		inputs, ok := node["inputs"].(map[string]any)
		if !ok {
			return fmt.Errorf("工作流节点 %s 没有 inputs", override.NodeID)
		}
		inputs[override.FieldName] = override.Value
	}
	return nil
}

func directComfyApplyMedia(ctx context.Context, base, apiKey string, workflow map[string]any, input WorkflowRunInput, overrides []WorkflowOverride) error {
	for index := range overrides {
		value, ok := overrides[index].Value.(map[string]any)
		if !ok {
			continue
		}
		mediaID := stringValue(value["mediaId"])
		if mediaID == "" {
			continue
		}
		source, err := workflowMediaSource(input, mediaID)
		if err != nil {
			return err
		}
		filename, err := directComfyUpload(ctx, base, apiKey, source, mediaID)
		if err != nil {
			return err
		}
		overrides[index].Value = filename
	}
	return nil
}

func directComfyUpload(ctx context.Context, base, apiKey, source, mediaID string) (string, error) {
	var data []byte
	contentType := "application/octet-stream"
	if strings.HasPrefix(source, "data:") {
		comma := strings.IndexByte(source, ',')
		if comma < 0 {
			return "", errors.New("ComfyUI 素材 data URL 无效")
		}
		header := source[:comma]
		encoded := source[comma+1:]
		var err error
		if strings.Contains(header, ";base64") {
			data, err = base64.StdEncoding.DecodeString(encoded)
		} else {
			var decoded string
			decoded, err = url.PathUnescape(encoded)
			data = []byte(decoded)
		}
		if err != nil {
			return "", err
		}
		if semi := strings.IndexByte(header, ';'); semi > 5 {
			contentType = header[5:semi]
		}
	} else {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if err != nil {
			return "", err
		}
		resp, err := (&http.Client{Timeout: 2 * time.Minute}).Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", fmt.Errorf("读取参考素材失败：%d", resp.StatusCode)
		}
		data, err = io.ReadAll(io.LimitReader(resp.Body, 100<<20))
		if err != nil {
			return "", err
		}
		if resp.Header.Get("Content-Type") != "" {
			contentType = resp.Header.Get("Content-Type")
		}
	}
	name := filepath.Base(strings.ReplaceAll(mediaID, ":", "_"))
	if name == "." || name == "" {
		name = "reference"
	}
	mediaType, _, _ := mime.ParseMediaType(contentType)
	ext := ".bin"
	switch strings.ToLower(mediaType) {
	case "image/png":
		ext = ".png"
	case "image/jpeg":
		ext = ".jpg"
	case "image/webp":
		ext = ".webp"
	case "video/mp4":
		ext = ".mp4"
	case "video/webm":
		ext = ".webm"
	case "video/quicktime":
		ext = ".mov"
	case "audio/mpeg":
		ext = ".mp3"
	case "audio/wav", "audio/x-wav":
		ext = ".wav"
	case "audio/mp4", "audio/x-m4a":
		ext = ".m4a"
	case "audio/ogg":
		ext = ".ogg"
	case "audio/flac":
		ext = ".flac"
	case "audio/aac":
		ext = ".aac"
	}
	name += ext
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", name)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	_ = writer.WriteField("type", "input")
	_ = writer.WriteField("overwrite", "true")
	if err = writer.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/upload/image", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := (&http.Client{Timeout: 3 * time.Minute}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("上传 ComfyUI 素材失败：%d %s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	var result map[string]any
	if json.Unmarshal(payload, &result) != nil {
		return "", errors.New("ComfyUI 素材上传响应无效")
	}
	filename := stringValue(result["name"])
	if filename == "" {
		filename = name
	}
	return filename, nil
}
