package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestBuiltinWorkflowFieldsAndOptionalReferences(t *testing.T) {
	for _, item := range builtinWorkflowList() {
		id := stringValue(item["workflowId"])[len(builtinWorkflowPrefix):]
		workflow, _, capability, err := builtinWorkflow(id)
		if err != nil || !isComfyAPIWorkflow(workflow) {
			t.Fatalf("invalid builtin %s: %v", id, err)
		}
		fields := discoverWorkflowFields(workflow, capability)
		prompt, images, audio := 0, 0, 0
		for _, raw := range fields {
			field, _ := mapValue(raw)
			switch stringValue(field["source"]) {
			case "prompt":
				prompt++
			case "referenceImage":
				images++
			case "referenceAudio":
				audio++
			}
		}
		if prompt != 1 || (id == "h3-ref" && (images != 4 || audio != 1)) {
			t.Fatalf("unexpected fields for %s: prompts=%d images=%d audio=%d", id, prompt, images, audio)
		}
		if id == "h3-ref" {
			if err := applyWorkflowFields(workflow, jsonMap{"workflowFields": fields}, nil); err != nil {
				t.Fatal(err)
			}
			inputs := mapValueMust(mapValueMust(workflow["5"])["inputs"])
			if _, ok := inputs["ref_images.ref_image_0"]; ok {
				t.Fatal("missing reference image link not removed")
			}
			if _, ok := inputs["ref_audios.ref_audio_0"]; ok {
				t.Fatal("missing reference audio link not removed")
			}
		}
	}
}

func TestAdaptH3VideoOutputUsesCPUEncoder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/object_info" {
			t.Fatalf("unexpected object info path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"VHS_VideoCombine\":{}}"))
	}))
	defer server.Close()
	workflow := jsonMap{"13": builtinNode("H3SaveVideo", jsonMap{"images": []any{"11", float64(0)}, "audio": []any{"12", float64(0)}, "fps": 24, "quality": "high", "filename_prefix": "InfiniteCanvas/H3"})}
	if err := adaptH3VideoOutput(context.Background(), server.URL, workflow); err != nil {
		t.Fatal(err)
	}
	node := mapValueMust(mapValueMust(workflow["13"]))
	if got := stringValue(node["class_type"]); got != "VHS_VideoCombine" {
		t.Fatalf("unexpected output node: %q", got)
	}
	inputs := mapValueMust(node["inputs"])
	if stringValue(inputs["format"]) != "video/h264-mp4" || stringValue(inputs["crf"]) != "18" {
		t.Fatalf("unexpected CPU encoder inputs: %#v", inputs)
	}
}

func TestBuiltinAgainstConfiguredComfy(t *testing.T) {
	url := os.Getenv("COMFY_TEST_URL")
	if url == "" {
		t.Skip("COMFY_TEST_URL not set")
	}
	for _, item := range builtinWorkflowList() {
		id := stringValue(item["workflowId"])[len(builtinWorkflowPrefix):]
		t.Run(id, func(t *testing.T) {
			if _, err := inspectBuiltinWorkflow(context.Background(), url, id); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRunComfyRequestSubmitsPollsAndCollectsResult(t *testing.T) {
	promptSubmitted := false
	historyPolled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/prompt":
			var body jsonMap
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode prompt request: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			workflow, _ := mapValue(body["prompt"])
			if stringValue(mapValueMust(workflow["1"])["class_type"]) != "SaveImage" {
				t.Errorf("unexpected submitted workflow: %#v", workflow)
			}
			promptSubmitted = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"prompt_id":"test-prompt"}`))
		case "/history/test-prompt":
			historyPolled = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"test-prompt":{"status":{"completed":true,"status_str":"success"},"outputs":{"1":{"images":[{"filename":"test.png","subfolder":"","type":"output"}]}}}}`))
		default:
			t.Errorf("unexpected ComfyUI request: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store := &recoveryStore{outputsDir: t.TempDir()}
	result, err := runComfyRequestFromCheckpoint(context.Background(), bridgeOptions{Comfy: server.URL}, store, jsonMap{
		"mode": "image",
		"workflowJson": jsonMap{
			"1": builtinNode("SaveImage", jsonMap{"filename_prefix": "test"}),
		},
	}, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !promptSubmitted || !historyPolled {
		t.Fatalf("expected prompt submission and history polling, got submitted=%t polled=%t", promptSubmitted, historyPolled)
	}
	images := sliceValue(result["images"])
	if len(images) != 1 {
		t.Fatalf("expected one collected image, got %#v", result)
	}
	image, _ := mapValue(images[0])
	if stringValue(image["name"]) != "test.png" || stringValue(image["url"]) == "" {
		t.Fatalf("unexpected collected image result: %#v", image)
	}
}
