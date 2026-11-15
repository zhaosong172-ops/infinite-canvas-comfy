package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkflowFieldsKeepOriginalBridgeExecution(t *testing.T) {
	workflow := jsonMap{
		"1": jsonMap{"class_type": "LoadImage", "inputs": jsonMap{"image": "old.png"}},
		"2": jsonMap{"class_type": "KSampler", "inputs": jsonMap{"image": []any{"1", float64(0)}, "steps": float64(20)}},
		"3": jsonMap{"class_type": "CLIPTextEncode", "inputs": jsonMap{"text": "old"}},
	}
	fields := []any{jsonMap{"nodeId": "1", "fieldName": "image", "source": "referenceImage", "sourceIndex": float64(0), "enabled": true}, jsonMap{"nodeId": "2", "fieldName": "steps", "source": "count", "enabled": true}}
	payload := jsonMap{"workflowFields": fields, "referenceImages": []any{}, "workflowOverrides": []any{jsonMap{"nodeId": "2", "fieldName": "steps", "value": float64(5)}}}
	if err := validateWorkflowMediaInputs(fields, payload); err != nil {
		t.Fatal(err)
	}
	if err := applyWorkflowFields(workflow, payload, map[string]string{}); err != nil {
		t.Fatal(err)
	}
	if _, exists := workflow["1"]; exists {
		t.Fatal("缺失的可选素材节点未删除")
	}
	inputs := workflow["2"].(jsonMap)["inputs"].(jsonMap)
	if _, exists := inputs["image"]; exists {
		t.Fatal("已删除素材节点的连接未清理")
	}
	if inputs["steps"] != float64(5) {
		t.Fatalf("工作流业务字段未传入：%#v", workflow)
	}
}

func TestMiniMaxH3PromptAddsReferenceTags(t *testing.T) {
	workflow := jsonMap{
		"5": builtinNode("MiniMaxH3ReferenceToVideo", jsonMap{
			"prompt":                 "一位少女沿街前行",
			"ref_images.ref_image_0": []any{"20", float64(0)},
			"ref_audios.ref_audio_0": []any{"24", float64(0)},
		}),
	}
	normalizeMiniMaxH3ReferencePrompt(workflow)
	inputs := mapValueMust(mapValueMust(workflow["5"])["inputs"])
	if got := stringValue(inputs["prompt"]); got != "<Picture 1> <Audio 1> 一位少女沿街前行" {
		t.Fatalf("unexpected H3 prompt: %q", got)
	}
}

func TestMiniMaxH3VideoOutputUsesAutoCodec(t *testing.T) {
	workflow := jsonMap{"13": builtinNode("H3SaveVideo", jsonMap{"codec": "h264"})}
	normalizeMiniMaxH3VideoOutput(workflow)
	inputs := mapValueMust(mapValueMust(workflow["13"])["inputs"])
	if got := stringValue(inputs["codec"]); got != "auto" {
		t.Fatalf("unexpected H3 codec: %q", got)
	}
}

func TestCollectOutputItemsRecognizesSingularVideo(t *testing.T) {
	var outputs []outputItem
	collectOutputItems(jsonMap{"video": []any{jsonMap{"filename": "result.mp4", "type": "output"}}}, "", &outputs)
	if len(outputs) != 1 || outputs[0].Kind != "video" || outputs[0].Filename != "result.mp4" {
		t.Fatalf("unexpected video output: %#v", outputs)
	}
}

func TestListRemoteWorkflowTemplatesFiltersUnsafeNames(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/workflow_templates" {
			t.Fatalf("unexpected catalog path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(
			`{"H3":["Video","../escape"],"bad/category":["Template"],"MOSS":[""]}`,
		))
	}))
	defer server.Close()

	items, err := listRemoteWorkflowTemplates(context.Background(), bridgeOptions{Comfy: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("expected one safe remote template, got %#v", items)
	}
	if got := stringValue(items[0]["workflowId"]); got != remoteWorkflowPrefix+"H3/Video" {
		t.Fatalf("unexpected workflow id: %q", got)
	}
	if stringValue(items[0]["source"]) != "remote-template" {
		t.Fatalf("unexpected source: %#v", items[0])
	}
}

func TestLoadRemoteWorkflowTemplateAndWorkflowSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workflow_templates/H3/Video.json" {
			t.Fatalf("unexpected template path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"workflow":{"1":{"class_type":"KSampler","inputs":{"steps":4}}}}`))
	}))
	defer server.Close()

	options := bridgeOptions{Comfy: server.URL}
	workflow, err := loadWorkflowSource(context.Background(), options, jsonMap{"workflowId": remoteWorkflowPrefix + "H3/Video"})
	if err != nil {
		t.Fatal(err)
	}
	if stringValue(mapValueMust(workflow["1"])["class_type"]) != "KSampler" {
		t.Fatalf("unexpected remote workflow: %#v", workflow)
	}
	if _, err := loadWorkflowSource(context.Background(), options, jsonMap{"workflowId": remoteWorkflowPrefix + "H3/../escape"}); err == nil {
		t.Fatal("unsafe remote workflow id was accepted")
	}
}

func TestLoadLocalWorkflowSourceStillUsesWorkflowDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "local.json")
	if err := os.WriteFile(path, []byte(`{"1":{"class_type":"LoadImage","inputs":{"image":"input.png"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	workflow, err := loadWorkflowSource(context.Background(), bridgeOptions{WorkflowDir: dir}, jsonMap{"workflowId": "local"})
	if err != nil {
		t.Fatal(err)
	}
	if stringValue(mapValueMust(workflow["1"])["class_type"]) != "LoadImage" {
		t.Fatalf("unexpected local workflow: %#v", workflow)
	}
}

func mapValueMust(value any) jsonMap {
	result, ok := mapValue(value)
	if !ok {
		panic("expected json map")
	}
	return result
}
