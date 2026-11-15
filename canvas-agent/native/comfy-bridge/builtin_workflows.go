package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

const builtinWorkflowPrefix = "builtin:"

func builtinNode(class string, inputs jsonMap) jsonMap {
	return jsonMap{"class_type": class, "inputs": inputs}
}

func builtinImageWorkflow(model, clip, clipType, vae, latent string, steps int, cfg float64, sampler string) jsonMap {
	return jsonMap{
		"1": builtinNode("UNETLoader", jsonMap{"unet_name": model, "weight_dtype": "default"}),
		"2": builtinNode("CLIPLoader", jsonMap{"clip_name": clip, "type": clipType, "device": "default"}),
		"3": builtinNode("VAELoader", jsonMap{"vae_name": vae}),
		"4": builtinNode("CLIPTextEncode", jsonMap{"clip": []any{"2", float64(0)}, "text": ""}),
		"5": jsonMap{"class_type": "CLIPTextEncode", "inputs": jsonMap{"clip": []any{"2", float64(0)}, "text": "worst quality, low quality, blurry, jpeg artifacts"}, "_meta": jsonMap{"title": "Negative prompt"}},
		"6": builtinNode(latent, jsonMap{"width": 1024, "height": 1024, "batch_size": 1}),
		"7": builtinNode("KSampler", jsonMap{"model": []any{"1", float64(0)}, "positive": []any{"4", float64(0)}, "negative": []any{"5", float64(0)}, "latent_image": []any{"6", float64(0)}, "seed": 0, "steps": steps, "cfg": cfg, "sampler_name": sampler, "scheduler": "simple", "denoise": 1}),
		"8": builtinNode("VAEDecode", jsonMap{"samples": []any{"7", float64(0)}, "vae": []any{"3", float64(0)}}),
		"9": builtinNode("SaveImage", jsonMap{"images": []any{"8", float64(0)}, "filename_prefix": "InfiniteCanvas"}),
	}
}

func builtinWorkflow(id string) (jsonMap, string, string, error) {
	switch id {
	case "anima":
		return builtinImageWorkflow("anima-preview3-base.safetensors", "qwen_3_06b_base.safetensors", "stable_diffusion", "qwen_image_vae.safetensors", "EmptyLatentImage", 30, 4, "er_sde"), "Anima 插画（内置待验证）", "image", nil
	case "moss":
		return builtinImageWorkflow("moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "moss_image", "flux2-vae_small.safetensors", "EmptyFlux2LatentImage", 50, 3, "euler"), "MOSS 图像（内置待验证）", "image", nil
	case "qwen21":
		w := builtinImageWorkflow("qwen_image_2.1_int8_convrot.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image", "qwen_image_2.1_vae_bf16.safetensors", "EmptyLatentImage", 25, 1, "euler")
		w["4"] = builtinNode("TextEncodeQwenImage21", jsonMap{"clip": []any{"2", float64(0)}, "prompt": "", "negative_prompt": "", "resolution": 1024})
		delete(w, "5")
		w["7"].(jsonMap)["inputs"].(jsonMap)["negative"] = []any{"4", float64(1)}
		w["7"].(jsonMap)["inputs"].(jsonMap)["latent_image"] = []any{"4", float64(2)}
		delete(w, "6")
		return w, "千问 2.1 生图（内置待验证）", "image", nil
	case "h3-ref":
		w := jsonMap{
			"1":  builtinNode("UNETLoader", jsonMap{"unet_name": "H3_ref2va_heptagram_turboV10.safetensors", "weight_dtype": "default"}),
			"2":  builtinNode("CLIPLoader", jsonMap{"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}),
			"3":  builtinNode("VAELoader", jsonMap{"vae_name": "minimax_h3_video_vae_fp16.safetensors"}),
			"4":  builtinNode("VAELoader", jsonMap{"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}),
			"5":  builtinNode("MiniMaxH3ReferenceToVideo", jsonMap{"clip": []any{"2", float64(0)}, "vae": []any{"3", float64(0)}, "audio_vae": []any{"4", float64(0)}, "prompt": "", "width": 736, "height": 1280, "length": 243, "ref_image_size": "match", "ref_images.ref_image_0": []any{"20", float64(0)}, "ref_images.ref_image_1": []any{"21", float64(0)}, "ref_images.ref_image_2": []any{"22", float64(0)}, "ref_images.ref_image_3": []any{"23", float64(0)}, "ref_audios.ref_audio_0": []any{"24", float64(0)}}),
			"6":  builtinNode("KSamplerSelect", jsonMap{"sampler_name": "res_multistep"}),
			"7":  builtinNode("BasicScheduler", jsonMap{"model": []any{"1", float64(0)}, "scheduler": "simple", "steps": 4, "denoise": 1}),
			"8":  builtinNode("RandomNoise", jsonMap{"noise_seed": 0}),
			"9":  builtinNode("BasicGuider", jsonMap{"model": []any{"1", float64(0)}, "conditioning": []any{"5", float64(0)}}),
			"10": builtinNode("SamplerCustomAdvanced", jsonMap{"noise": []any{"8", float64(0)}, "guider": []any{"9", float64(0)}, "sampler": []any{"6", float64(0)}, "sigmas": []any{"7", float64(0)}, "latent_image": []any{"5", float64(1)}}),
			"11": builtinNode("VAEDecode", jsonMap{"samples": []any{"10", float64(0)}, "vae": []any{"3", float64(0)}}),
			"12": builtinNode("VAEDecodeAudio", jsonMap{"samples": []any{"10", float64(0)}, "vae": []any{"4", float64(0)}}),
			"13": builtinNode("H3SaveVideo", jsonMap{"images": []any{"11", float64(0)}, "audio": []any{"12", float64(0)}, "fps": 24, "frame_gen": "off", "codec": "auto", "quality": "high", "filename_prefix": "InfiniteCanvas/H3"}),
			"20": builtinNode("LoadImage", jsonMap{"image": ""}),
			"21": builtinNode("LoadImage", jsonMap{"image": ""}),
			"22": builtinNode("LoadImage", jsonMap{"image": ""}),
			"23": builtinNode("LoadImage", jsonMap{"image": ""}),
			"24": builtinNode("LoadAudio", jsonMap{"audio": ""}),
		}
		return w, "MiniMax H3 多参考图视频（内置待验证）", "video", nil
	default:
		return nil, "", "", errors.New("未知内置工作流")
	}
}

func builtinWorkflowList() []jsonMap {
	items := make([]jsonMap, 0, 4)
	for _, id := range []string{"anima", "moss", "qwen21", "h3-ref"} {
		_, title, capability, _ := builtinWorkflow(id)
		items = append(items, jsonMap{"workflowId": builtinWorkflowPrefix + id, "title": title, "capability": capability, "source": "builtin"})
	}
	return items
}

func inspectBuiltinWorkflow(ctx context.Context, comfy, id string) (jsonMap, error) {
	w, _, _, err := builtinWorkflow(id)
	if err != nil {
		return nil, err
	}
	var info jsonMap
	if err := requestComfyJSONContext(ctx, http.MethodGet, strings.TrimRight(comfy, "/")+"/object_info", nil, &info); err != nil {
		return nil, fmt.Errorf("读取 ComfyUI 节点定义失败：%w", err)
	}
	for _, raw := range w {
		node, _ := mapValue(raw)
		class := stringValue(node["class_type"])
		definition, ok := mapValue(info[class])
		if !ok {
			return nil, fmt.Errorf("云端缺少节点 %s", class)
		}
		inputs, _ := mapValue(node["inputs"])
		if err := validateWorkflowNodeInputs(class, inputs, definition); err != nil {
			return nil, err
		}
		for _, field := range []string{"unet_name", "clip_name", "vae_name"} {
			value := stringValue(inputs[field])
			if value == "" {
				continue
			}
			defs, _ := mapValue(definition["input"])
			required, _ := mapValue(defs["required"])
			entry := sliceValue(required[field])
			if len(entry) == 0 {
				return nil, fmt.Errorf("节点 %s 缺少模型列表", class)
			}
			found := false
			for _, item := range sliceValue(entry[0]) {
				if stringValue(item) == value {
					found = true
					break
				}
			}
			if !found {
				return nil, fmt.Errorf("云端缺少模型 %s", value)
			}
		}
	}
	return w, nil
}

func validateWorkflowNodeInputs(class string, inputs, definition jsonMap) error {
	inputDefinitions, _ := mapValue(definition["input"])
	required, _ := mapValue(inputDefinitions["required"])
	optional, _ := mapValue(inputDefinitions["optional"])
	for name, spec := range required {
		if dynamicInputCanBeEmpty(spec) {
			continue
		}
		if _, ok := inputs[name]; !ok {
			return fmt.Errorf("节点 %s 缺少必填输入 %s", class, name)
		}
	}
	for name, value := range inputs {
		spec, ok := required[name]
		if !ok {
			spec, ok = optional[name]
		}
		if !ok {
			if !matchesDynamicInput(name, optional) {
				return fmt.Errorf("节点 %s 不存在输入 %s", class, name)
			}
			continue
		}
		if stringValue(value) == "" && isMediaPlaceholder(class, name) {
			continue
		}
		choices := sliceValue(spec)
		if len(choices) == 0 {
			continue
		}
		values := sliceValue(choices[0])
		if len(values) == 0 {
			continue
		}
		isChoiceList := true
		for _, choice := range values {
			if _, ok := choice.(string); !ok {
				isChoiceList = false
				break
			}
		}
		if !isChoiceList {
			continue
		}
		selected := stringValue(value)
		found := false
		for _, choice := range values {
			if stringValue(choice) == selected {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("节点 %s 输入 %s 不支持值 %s", class, name, selected)
		}
	}
	return nil
}

func dynamicInputCanBeEmpty(rawSpec any) bool {
	spec := sliceValue(rawSpec)
	if len(spec) < 2 || stringValue(spec[0]) != "COMFY_AUTOGROW_V3" {
		return false
	}
	metadata, _ := mapValue(spec[1])
	template, _ := mapValue(metadata["template"])
	return numberValue(template["min"]) == 0
}

func isMediaPlaceholder(class, name string) bool {
	class, name = normalizeSourceName(class), normalizeSourceName(name)
	return class == "loadimage" && name == "image" || class == "loadaudio" && name == "audio"
}

func matchesDynamicInput(name string, optional jsonMap) bool {
	for group, rawSpec := range optional {
		if !strings.HasPrefix(name, group+".") {
			continue
		}
		spec := sliceValue(rawSpec)
		if len(spec) < 2 {
			continue
		}
		metadata, _ := mapValue(spec[1])
		template, _ := mapValue(metadata["template"])
		input, _ := mapValue(template["input"])
		if len(input) == 0 {
			continue
		}
		prefix := stringValue(template["prefix"])
		childName := strings.TrimPrefix(name, group+".")
		if prefix != "" && strings.HasPrefix(childName, prefix) {
			return true
		}
		for _, rawNames := range sliceValue(template["names"]) {
			if stringValue(rawNames) == childName {
				return true
			}
		}
	}
	return false
}
