package service

import "github.com/tigerowo/infinite-canvas/model"

func directBuiltinWorkflow(id string) (model.WorkflowEntry, bool) {
	enabled := true
	node := func(class string, inputs map[string]any) map[string]any {
		return map[string]any{"class_type": class, "inputs": inputs}
	}
	image := func(modelName, clip, clipType, vae, latent string, steps int, cfg float64, sampler string) map[string]any {
		return map[string]any{
			"1": node("UNETLoader", map[string]any{"unet_name": modelName, "weight_dtype": "default"}),
			"2": node("CLIPLoader", map[string]any{"clip_name": clip, "type": clipType, "device": "default"}),
			"3": node("VAELoader", map[string]any{"vae_name": vae}),
			"4": node("CLIPTextEncode", map[string]any{"clip": []any{"2", float64(0)}, "text": ""}),
			"5": node("CLIPTextEncode", map[string]any{"clip": []any{"2", float64(0)}, "text": "worst quality, low quality, blurry, jpeg artifacts"}),
			"6": node(latent, map[string]any{"width": 1024, "height": 1024, "batch_size": 1}),
			"7": node("KSampler", map[string]any{"model": []any{"1", float64(0)}, "positive": []any{"4", float64(0)}, "negative": []any{"5", float64(0)}, "latent_image": []any{"6", float64(0)}, "seed": float64(0), "steps": float64(steps), "cfg": cfg, "sampler_name": sampler, "scheduler": "simple", "denoise": float64(1)}),
			"8": node("VAEDecode", map[string]any{"samples": []any{"7", float64(0)}, "vae": []any{"3", float64(0)}}),
			"9": node("SaveImage", map[string]any{"images": []any{"8", float64(0)}, "filename_prefix": "InfiniteCanvas"}),
		}
	}
	entry := model.WorkflowEntry{Provider: "comfyui", Kind: "workflow", Enabled: enabled, Fields: []model.WorkflowFieldMapping{}}
	switch id {
	case "builtin:anima":
		entry.WorkflowID, entry.Title, entry.Capability = id, "Anima 插画", "image"
		entry.WorkflowJSON = image("anima-preview3-base.safetensors", "qwen_3_06b_base.safetensors", "stable_diffusion", "qwen_image_vae.safetensors", "EmptyLatentImage", 30, 4, "er_sde")
	case "builtin:moss":
		entry.WorkflowID, entry.Title, entry.Capability = id, "MOSS 图像", "image"
		entry.WorkflowJSON = image("moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "moss_image", "flux2-vae_small.safetensors", "EmptyFlux2LatentImage", 50, 3, "euler")
	case "builtin:qwen21":
		entry.WorkflowID, entry.Title, entry.Capability = id, "千问 2.1 生图", "image"
		entry.WorkflowJSON = image("qwen_image_2.1_int8_convrot.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image", "qwen_image_2.1_vae_bf16.safetensors", "EmptyLatentImage", 25, 1, "euler")
		entry.WorkflowJSON["4"] = node("TextEncodeQwenImage21", map[string]any{"clip": []any{"2", float64(0)}, "prompt": "", "negative_prompt": "", "resolution": float64(1024)})
		delete(entry.WorkflowJSON, "5")
		entry.WorkflowJSON["7"].(map[string]any)["inputs"].(map[string]any)["negative"] = []any{"4", float64(1)}
		entry.WorkflowJSON["7"].(map[string]any)["inputs"].(map[string]any)["latent_image"] = []any{"4", float64(2)}
		delete(entry.WorkflowJSON, "6")
	default:
		return model.WorkflowEntry{}, false
	}
	entry.Fields = directBuiltinFields(entry)
	return entry, true
}

func directBuiltinFields(entry model.WorkflowEntry) []model.WorkflowFieldMapping {
	enabled := true
	if entry.WorkflowID == "builtin:qwen21" {
		return []model.WorkflowFieldMapping{{NodeID: "4", FieldName: "prompt", Source: "prompt", Role: "prompt", BindPrompt: true, Enabled: &enabled}}
	}
	return []model.WorkflowFieldMapping{{NodeID: "4", FieldName: "text", Source: "prompt", Role: "prompt", BindPrompt: true, Enabled: &enabled}, {NodeID: "5", FieldName: "text", Source: "negativePrompt", Role: "business", Enabled: &enabled}}
}
