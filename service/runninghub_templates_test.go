package service

import "testing"

func TestParseRunningHubTemplates(t *testing.T) {
	items, err := parseRunningHubTemplates(map[string]any{
		"data": map[string]any{"records": []any{
			map[string]any{
				"id": "2121695439492829185", "name": "MiniMax H3 image to video", "desc": "H3 workflow",
				"owner":          map[string]any{"name": "creator"},
				"statisticsInfo": map[string]any{"useCount": "12"}, "labels": "video",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].WorkflowID != "2121695439492829185" || items[0].Author != "creator" || items[0].UseCount != "12" {
		t.Fatalf("unexpected directory result: %#v", items)
	}
}

func TestParseRunningHubTemplatesRejectsInvalidResponse(t *testing.T) {
	if _, err := parseRunningHubTemplates(map[string]any{"data": map[string]any{}}); err == nil {
		t.Fatal("expected invalid directory response error")
	}
}
