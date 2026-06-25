import React, { memo, useState, useEffect, useCallback } from "react";
import { FolderOpen, DownloadCloud, RefreshCw, Database, Trash2, Square, HardDrive, Library, AlertTriangle, Search, X } from "lucide-react";
import { 
  listLocalModels, 
  startServer, 
  stopServer, 
  importModelFile, 
  deleteModel, 
  downloadModel, 
  downloadOpenVinoModel, 
  cancelModelDownload, 
  getDownloadProgress, 
  getBackendStatus, 
  pingServer, 
  formatBytes, 
  normalizeModel,
  listLlmModels,
  startLlm,
  stopLlm,
  downloadLlmModel,
  deleteLlmModel,
  importLlmModel,
  getLlmStatus,
  searchHuggingFaceModels,
  listSpeechModels,
  startSpeech,
  stopSpeech,
  downloadSpeechModel,
  deleteSpeechModel,
  importSpeechModel,
  getSpeechStatus,
  listTtsModels,
  startTts,
  stopTts,
  downloadTtsModel,
  deleteTtsModel,
  importTtsModel,
  getTtsStatus,
  isLocalServerMode
} from "../services/api";

const MODEL_FILTERS = [
  { id: "vision", label: "Vision" },
  { id: "uncensored", label: "Uncensored" },
];

const MODEL_LIBRARY = [
  {
    group: "SDXL - Best Quality",
    items: [
      {
        name: "Juggernaut XL v9 Lightning",
        filename: "Juggernaut_RunDiffusionPhoto2_Lightning_4Steps.safetensors",
        format: "Safetensors",
        approxSize: "6.6 GB",
        resolution: "1024x1024",
        notes: "Photorealistic SDXL model tuned for 4-8 step Lightning generation.",
        url: "https://huggingface.co/RunDiffusion/Juggernaut-XL-Lightning/resolve/main/Juggernaut_RunDiffusionPhoto2_Lightning_4Steps.safetensors",
        recommendedTiers: ["Mid", "High"],
      },
      {
        name: "DreamShaper XL Lightning",
        filename: "DreamShaperXL_Lightning.safetensors",
        format: "Safetensors",
        approxSize: "6.6 GB",
        resolution: "1024x1024",
        notes: "All-around SDXL model for fantasy art, renders, illustration, and stylized images.",
        url: "https://huggingface.co/Lykon/dreamshaper-xl-lightning/resolve/main/DreamShaperXL_Lightning.safetensors",
        recommendedTiers: ["Mid", "High"],
      },
    ],
  },
  {
    group: "SD 1.5 - Ultra Fast / Low Memory",
    items: [
      {
        name: "DreamShaper 8",
        filename: "DreamShaper_8_pruned.safetensors",
        format: "Safetensors",
        approxSize: "2.1 GB",
        resolution: "512x512",
        notes: "General-purpose SD 1.5 model for illustration, anime, and semi-realistic portraits.",
        url: "https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors",
        recommendedTiers: ["Low"],
      },
      {
        name: "CyberRealistic V8",
        filename: "CyberRealistic_V8_FP16.safetensors",
        format: "Safetensors",
        approxSize: "2.1 GB",
        resolution: "512x512",
        notes: "High-fidelity realism and photorealism in the SD 1.5 ecosystem.",
        url: "https://huggingface.co/cyberdelia/CyberRealistic/resolve/main/CyberRealistic_V8_FP16.safetensors",
        recommendedTiers: ["Low"],
      },
      {
        name: "ReV Animated v1.2.2",
        filename: "rev-animated-v1-2-2.safetensors",
        format: "Safetensors",
        approxSize: "2.1 GB",
        resolution: "512x512",
        notes: "Semi-realistic, 2.5D, anime, fantasy, and stylized digital art.",
        url: "https://huggingface.co/danbrown/RevAnimated-v1-2-2/resolve/main/rev-animated-v1-2-2.safetensors",
        recommendedTiers: ["Low"],
      },
    ],
  },
];

const TEXT_MODEL_LIBRARY = [
  {
    group: "Recommended Text Models (llama.cpp)",
    items: [
      {
        name: "Qwen2.5 Coder 0.5B Instruct Q4_K_M",
        filename: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        format: "GGUF",
        approxSize: "491 MB",
        resolution: "N/A",
        notes: "Extremely fast, lightweight assistant, perfect for low RAM/VRAM machines.",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        recommendedTiers: ["Low"],
      },
      {
        name: "SmolLM2 1.7B Instruct Q4_K_M",
        filename: "smollm2-1.7b-instruct-q4_k_m.gguf",
        format: "GGUF",
        approxSize: "1.1 GB",
        resolution: "N/A",
        notes: "Excellent lightweight assistant with strong logic, reasoning, and prompt expansion capabilities.",
        url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
        recommendedTiers: ["Low"],
      },
      {
        name: "Qwen2.5-Coder-7B-Instruct",
        filename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        format: "GGUF",
        size: "4.7 GB",
        approxSize: "4.7 GB",
        resolution: "N/A",
        notes: "Highly intelligent coding and text assistant. Recommended for mid/high tier systems.",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        recommendedTiers: ["Mid", "High"],
      },
      {
        name: "Llama-3.1-8B-Instruct",
        filename: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
        format: "GGUF",
        size: "4.9 GB",
        approxSize: "4.9 GB",
        resolution: "N/A",
        notes: "Excellent general-purpose text model. Recommended for high-tier systems.",
        url: "https://huggingface.co/lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
        recommendedTiers: ["High"],
      },
      {
        name: "LLaVA 1.5 7B",
        filename: "ggml-model-q4_k.gguf",
        format: "GGUF",
        size: "4.5 GB",
        approxSize: "4.5 GB",
        resolution: "N/A",
        notes: "Multimodal model capable of understanding images. Downloads companion vision projector automatically.",
        url: "https://huggingface.co/mys/ggml_llava-v1.5-7b/resolve/main/ggml-model-q4_k.gguf",
        projectorUrl: "https://huggingface.co/mys/ggml_llava-v1.5-7b/resolve/main/mmproj-model-f16.gguf",
        projectorFilename: "mmproj-model-f16.gguf",
        recommendedTiers: ["Mid", "High"],
      },
    ],
  },
];

const OPENVINO_MODEL_LIBRARY = [
  {
    group: "Intel NPU - OpenVINO Test",
    items: [
      {
        id: "lcm-dreamshaper-v7-fp16",
        name: "LCM DreamShaper v7 FP16",
        filename: "lcm-dreamshaper-v7-fp16",
        format: "OpenVINO",
        backendType: "openvino-npu",
        approxSize: "2.0 GB",
        resolution: "512x512",
        notes: "NPU test model for Windows and Linux. Runs the text encoder on CPU, UNet on Intel NPU, and VAE decoder on Intel GPU or CPU fallback.",
        url: "https://huggingface.co/OpenVINO/LCM_Dreamshaper_v7-fp16-ov",
      },
    ],
  },
];

const TTS_MODEL_LIBRARY = [
  {
    group: "Kokoro Text-to-Speech Models",
    items: [
      {
        id: "kokoro-onnx-q8",
        name: "Kokoro 82M ONNX Q8",
        filename: "kokoro-onnx-q8.json",
        format: "Kokoro ONNX",
        approxSize: "Model cache on first use",
        resolution: "24 kHz WAV",
        notes: "Recommended local TTS model. Good quality and faster startup than full precision on most PCs.",
        url: "kokoro://install/kokoro-onnx-q8",
        pageUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
        recommendedTiers: ["Low", "Mid", "High"],
      },
      {
        id: "kokoro-onnx-fp32",
        name: "Kokoro 82M ONNX FP32",
        filename: "kokoro-onnx-fp32.json",
        format: "Kokoro ONNX",
        approxSize: "Model cache on first use",
        resolution: "24 kHz WAV",
        notes: "Full precision Kokoro ONNX path for quality testing. Uses more memory and disk cache.",
        url: "kokoro://install/kokoro-onnx-fp32",
        pageUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
        recommendedTiers: ["Mid", "High"],
      },
    ],
  },
];

const COREML_MODEL_LIBRARY = [
  {
    group: "Apple Silicon NPU - CoreML Test",
    items: [
      {
        name: "Stable Diffusion v1.5 CoreML (split_einsum, palettized 6-bit)",
        filename: "coreml-stable-diffusion-v1-5-palettized_split_einsum_v2_compiled",
        format: "CoreML",
        approxSize: "2.0 GB",
        resolution: "512x512",
        notes: "Apple Silicon ANE (Neural Engine) optimized 6-bit palettized Stable Diffusion 1.5 model. Unzips automatically on download completion and runs extremely fast on Mac NPUs.",
        url: "https://huggingface.co/apple/coreml-stable-diffusion-v1-5-palettized/resolve/main/coreml-stable-diffusion-v1-5-palettized_split_einsum_v2_compiled.zip",
      },
      {
        name: "CyberRealistic v1.5 CoreML (6-bit palettized)",
        filename: "cyberrealistic-6bit.coreml",
        format: "CoreML",
        approxSize: "815 MB",
        resolution: "512x512",
        notes: "6-bit palettized CoreML version of CyberRealistic. Extremely fast and optimized for Apple Silicon Neural Engine (ANE).",
        url: "https://huggingface.co/orailnooor/cyberrealistic-coreml/resolve/main/cyberrealistic-6bit.coreml.zip",
      },
      {
        name: "CyberRealistic v1.5 CoreML (Standard)",
        filename: "cyberrealistic.coreml",
        format: "CoreML",
        approxSize: "1.8 GB",
        resolution: "512x512",
        notes: "Standard CoreML version of CyberRealistic. Provides high-fidelity realism optimized for Apple Silicon NPUs.",
        url: "https://huggingface.co/orailnooor/cyberrealistic-coreml/resolve/main/cyberrealistic.coreml.zip",
      },
    ],
  },
];

const getHardwareTier = (specs) => {
  if (!specs) return "Low";
  const ram = Number(specs.ram_total_gb) || 0;
  const vram = Number(specs.gpu_vram_gb) || 0;

  if (vram >= 12 || (vram >= 8 && ram >= 32)) {
    return "High";
  } else if (vram >= 6 || ram >= 16) {
    return "Mid";
  } else {
    return "Low";
  }
};

function ModelManager({ 
  activeModel, 
  setActiveModel, 
  serverRunning, 
  setServerRunning, 
  constraints, 
  setConstraints, 
  telemetry, 
  backendOptions, 
  showAlert = async ({ message }) => window.alert(message), 
  showConfirm = async ({ message }) => window.confirm(message), 
  activeTab,
  specs,
  textSettings,
}) {
  const [activeModelType, setActiveModelType] = useState("image"); // "image", "text", "speech", or "tts"
  const [localModels, setLocalModels] = useState([]);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [downloadingModelId, setDownloadingModelId] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState("");
  const [loadingModelId, setLoadingModelId] = useState(null);
  const [modelLoadProgress, setModelLoadProgress] = useState(null);
  const [importProgress, setImportProgress] = useState(null); // null when not importing
  const [importInfo, setImportInfo] = useState({ filename: "", speed: "0.0", eta: 0, status: "" });
  const [downloadUrl, setDownloadUrl] = useState("");
  const [importAbortController, setImportAbortController] = useState(null);
  const [isUnloading, setIsUnloading] = useState(false);
  const [unloadProgress, setUnloadProgress] = useState({ progress: 0, phase: "" });
  const [pendingLoadModel, setPendingLoadModel] = useState(null);
  const [vramWarning, setVramWarning] = useState(null);
  const [backendInfo, setBackendInfo] = useState({ backendMode: "", backendBinary: "", backendDevice: "" });
  const [activeLlmModel, setActiveLlmModel] = useState(null);
  const [llmRunning, setLlmRunning] = useState(false);
  const [activeSpeechModel, setActiveSpeechModel] = useState(null);
  const [speechRunning, setSpeechRunning] = useState(false);
  const [activeTtsModel, setActiveTtsModel] = useState(null);
  const [ttsRunning, setTtsRunning] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedFilters, setSelectedFilters] = useState([]);
  const [huggingFaceModels, setHuggingFaceModels] = useState([]);
  const [isSearchingModels, setIsSearchingModels] = useState(false);
  const [modelSearchError, setModelSearchError] = useState("");
  const [hasHuggingFaceResults, setHasHuggingFaceResults] = useState(false);
  const [modelSearchPage, setModelSearchPage] = useState(1);
  const [hasMoreModels, setHasMoreModels] = useState(false);
  const [isLoadingMoreModels, setIsLoadingMoreModels] = useState(false);
  const searchRequestRef = React.useRef(0);
  const pendingCompanionDownloadRef = React.useRef(null);

  const cancelLoadRef = React.useRef(false);
  
  const handleCancelLoad = async () => {
    cancelLoadRef.current = true;
    try {
      await stopServer();
    } catch (err) {
      console.warn("Failed to stop server on cancel:", err);
    }
  };

  const normalizedLocalModels = activeModelType === "speech" || activeModelType === "tts"
    ? localModels.filter((model) => model.filename)
    : localModels.map(normalizeModel).filter((model) => model.filename);
  const displayedLocalModels = activeModelType === "speech" || activeModelType === "tts"
    ? normalizedLocalModels.filter((model) => model.installed)
    : normalizedLocalModels.filter((model) => !model.isProjector);
  const allModelNames = activeModelType === "speech" || activeModelType === "tts"
    ? displayedLocalModels.map((model) => model.filename)
    : normalizedLocalModels.map((model) => model.filename);
  const modelNames = displayedLocalModels.map((model) => model.filename);
  const isBusy = loadingModelId !== null || isUnloading;
  
  const openvinoSupported = Boolean(backendOptions?.openvinoNpu?.supported);
  const appleNpuSupported = Boolean(
    backendOptions?.options?.some((opt) => opt.id === "apple-npu") ||
    backendOptions?.unavailable?.some((opt) => opt.id === "apple-npu")
  );
  const displayedHuggingFaceModels = huggingFaceModels.filter((model) => (
    selectedFilters.every((filterId) => model.tags?.includes(filterId))
  ));

  const getModelTypeLabel = (type) => {
    if (type === "image") return "Image";
    if (type === "text") return "Text";
    if (type === "speech") return "Speech";
    if (type === "tts") return "TTS";
    return "Model";
  };

  const getRuntimeForType = (type) => {
    if (type === "image" && serverRunning && activeModel) {
      return { type: "image", model: activeModel, label: getModelTypeLabel("image") };
    }
    if (type === "text" && llmRunning && activeLlmModel) {
      return { type: "text", model: activeLlmModel, label: getModelTypeLabel("text") };
    }
    if (type === "speech" && speechRunning && activeSpeechModel) {
      return { type: "speech", model: activeSpeechModel, label: getModelTypeLabel("speech") };
    }
    if (type === "tts" && ttsRunning && activeTtsModel) {
      return { type: "tts", model: activeTtsModel, label: getModelTypeLabel("tts") };
    }
    return null;
  };

  const getActiveHeavyRuntime = () => (
    getRuntimeForType("image") ||
    getRuntimeForType("text")
  );

  const blockLoadIfOtherRuntimeActive = (modelId, targetType) => {
    if (targetType !== "image" && targetType !== "text") {
      return false;
    }

    const runtime = getActiveHeavyRuntime();
    if (!runtime || (runtime.type === targetType && runtime.model === modelId)) {
      return false;
    }
    setPendingLoadModel({
      modelId,
      targetType,
      activeRuntime: runtime,
    });
    return true;
  };
  
  let visibleModelLibrary = [];
  if (activeModelType === "image") {
    visibleModelLibrary = [...MODEL_LIBRARY];
    if (openvinoSupported) {
      visibleModelLibrary = [...visibleModelLibrary, ...OPENVINO_MODEL_LIBRARY];
    }
    if (appleNpuSupported) {
      visibleModelLibrary = [...visibleModelLibrary, ...COREML_MODEL_LIBRARY];
    }
  } else if (activeModelType === "text") {
    visibleModelLibrary = [{
      group: "Recommended Text Models from Hugging Face",
      items: hasHuggingFaceResults ? displayedHuggingFaceModels : TEXT_MODEL_LIBRARY[0].items,
    }];
  } else if (activeModelType === "speech") {
    visibleModelLibrary = [{
      group: "Whisper Speech Models",
      items: normalizedLocalModels.filter((model) => model.url).map((model) => ({
        ...model,
        format: "Whisper.cpp",
        approxSize: model.size,
        notes: `${model.language || "Speech"} transcription model. Stored in app/speech-models/.`,
        recommendedTiers: model.recommended ? ["Low", "Mid", "High"] : [],
      })),
    }];
  } else {
    visibleModelLibrary = TTS_MODEL_LIBRARY;
  }

  useEffect(() => {
    if (activeModelType !== "text") return;
    const requestId = ++searchRequestRef.current;
    const timer = setTimeout(async () => {
      setIsSearchingModels(true);
      setModelSearchError("");
      try {
        const result = await searchHuggingFaceModels(modelSearch, selectedFilters, 1);
        if (requestId !== searchRequestRef.current) return;
        const matchingModels = result.models.filter((model) => (
          selectedFilters.every((filterId) => model.tags?.includes(filterId))
        ));
        setHuggingFaceModels(matchingModels);
        setHasHuggingFaceResults(true);
        setModelSearchPage(1);
        setHasMoreModels(result.hasMore);
      } catch (err) {
        if (requestId !== searchRequestRef.current) return;
        setHuggingFaceModels([]);
        setHasHuggingFaceResults(false);
        setHasMoreModels(false);
        setModelSearchError(err.message || "Could not search Hugging Face.");
      } finally {
        if (requestId === searchRequestRef.current) setIsSearchingModels(false);
      }
    }, modelSearch ? 400 : 0);
    return () => clearTimeout(timer);
  }, [activeModelType, modelSearch, selectedFilters]);

  const toggleModelFilter = (filterId) => {
    setSelectedFilters((current) => (
      current.includes(filterId)
        ? current.filter((id) => id !== filterId)
        : [...current, filterId]
    ));
  };

  const handleLoadMoreModels = async () => {
    if (isLoadingMoreModels || !hasMoreModels) return;
    const nextPage = modelSearchPage + 1;
    setIsLoadingMoreModels(true);
    setModelSearchError("");
    try {
      const [result] = await Promise.all([
        searchHuggingFaceModels(modelSearch, selectedFilters, nextPage),
        new Promise((resolve) => setTimeout(resolve, 350)),
      ]);
      const matchingModels = result.models.filter((model) => (
        selectedFilters.every((filterId) => model.tags?.includes(filterId))
      ));
      setHuggingFaceModels((current) => {
        const known = new Set(current.map((model) => model.id));
        return [...current, ...matchingModels.filter((model) => !known.has(model.id))];
      });
      setModelSearchPage(result.page);
      setHasMoreModels(result.hasMore);
    } catch (err) {
      setModelSearchError(err.message || "Could not load more Hugging Face models.");
    } finally {
      setIsLoadingMoreModels(false);
    }
  };
  
  const getLocalModelInfo = (modelId) => localModels.map(normalizeModel).find((model) => model.filename === modelId);

  const fetchModels = useCallback(async () => {
    setIsLoadingModels(true);
    try {
      if (activeModelType === "image") {
        const list = await listLocalModels();
        setLocalModels(list.map(normalizeModel).filter((model) => model.filename));
      } else if (activeModelType === "text") {
        const list = await listLlmModels();
        setLocalModels(list.map(normalizeModel).filter((model) => model.filename));
      } else if (activeModelType === "speech") {
        const list = await listSpeechModels();
        setLocalModels(list.filter((model) => model.filename));
      } else {
        const list = await listTtsModels();
        setLocalModels(list.filter((model) => model.filename));
      }
    } catch (e) {
      console.error(e);
      setLocalModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  }, [activeModelType]);

  useEffect(() => {
    if (activeTab === "models") {
      fetchModels();
      checkActiveDownload();
    }
  }, [activeTab, fetchModels]);

  useEffect(() => {
    fetchModels();
    checkActiveDownload();
  }, [activeModelType]);

  useEffect(() => {
    let cancelled = false;
    const updateBackendInfo = async () => {
      try {
        const [sdStatus, llmStatus, speechStatus, ttsStatus] = await Promise.all([
          getBackendStatus(),
          getLlmStatus(),
          getSpeechStatus(),
          getTtsStatus()
        ]);
        if (cancelled) return;
        
        setBackendInfo({
          backendMode: sdStatus.settings?.backendMode || sdStatus.loading?.backendMode || "",
          backendBinary: sdStatus.settings?.backendBinary || sdStatus.loading?.backendBinary || "",
          backendDevice: sdStatus.settings?.backendDevice || sdStatus.loading?.device || "",
          llmBackendMode: llmStatus.settings?.backendMode || llmStatus.settings?.backendBinary || "",
          speechBackendMode: speechStatus.settings?.backendMode || speechStatus.backendMode || "",
          ttsBackendMode: ttsStatus.settings?.backendMode || ttsStatus.backendMode || "",
        });
        
        if (llmStatus.ready) {
          setActiveLlmModel(llmStatus.settings?.model || null);
          setLlmRunning(true);
        } else {
          setActiveLlmModel(null);
          setLlmRunning(false);
        }
        if (speechStatus.ready) {
          setActiveSpeechModel(speechStatus.settings?.model || null);
          setSpeechRunning(true);
        } else {
          setActiveSpeechModel(null);
          setSpeechRunning(false);
        }
        if (ttsStatus.ready) {
          setActiveTtsModel(ttsStatus.settings?.model || null);
          setTtsRunning(true);
        } else {
          setActiveTtsModel(null);
          setTtsRunning(false);
        }
      } catch (_) {}
    };

    updateBackendInfo();
    const interval = setInterval(updateBackendInfo, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverRunning, loadingModelId]);

  const checkActiveDownload = async () => {
    try {
      const status = await getDownloadProgress();
      if (status.active && status.filename) {
        startProgressPolling(status.filename);
      }
    } catch (e) {
      console.error("Check active download failed:", e);
    }
  };

  const downloadByUrl = async (url, expectedFilename, companion = null, options = {}) => {
    if (downloadingModelId) return;

    if (!options.skipExistingConfirm && allModelNames.includes(expectedFilename)) {
      if (!(await showConfirm({
        title: "Overwrite Model?",
        message: `"${expectedFilename}" is already downloaded. Do you want to download and overwrite it?`,
        confirmLabel: "Overwrite",
      }))) {
        return;
      }
    }

    const isTauriDesktop = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

    if (!isTauriDesktop && !isLocalServerMode()) {
      showAlert({ title: "Server Required", message: "Model download requires the local server.", danger: true });
      return;
    }

    try {
      pendingCompanionDownloadRef.current = companion;
      let res;
      if (activeModelType === "image") {
        res = await downloadModel(url);
      } else if (activeModelType === "text") {
        res = await downloadLlmModel(url, expectedFilename, companion);
      } else if (activeModelType === "speech") {
        res = await downloadSpeechModel(url, expectedFilename);
      } else {
        res = await downloadTtsModel(url, expectedFilename);
      }
      if (res && res.ok) {
        if (!companion && res.projectorUrl && res.projectorFilename) {
          pendingCompanionDownloadRef.current = {
            url: res.projectorUrl,
            filename: res.projectorFilename,
          };
        }
        startProgressPolling(expectedFilename);
      } else {
        pendingCompanionDownloadRef.current = null;
        showAlert({ title: "Download Failed", message: res.error || "Unknown error", danger: true });
      }
    } catch (err) {
      pendingCompanionDownloadRef.current = null;
      showAlert({ title: "Download Error", message: err.message, danger: true });
    }
  };

  const startProgressPolling = (modelId) => {
    setDownloadingModelId(modelId);
    
    const interval = setInterval(async () => {
      try {
        const status = await getDownloadProgress();
        if (status.active) {
          setDownloadProgress(status.progress === -1 ? 0 : status.progress);
          setDownloadSpeed(`${status.speed} • ETA ${status.eta}s`);
        } else {
          clearInterval(interval);
          setDownloadingModelId(null);
          if (status.error) {
            if (!String(status.error).toLowerCase().includes("cancelled")) {
              showAlert({ title: "Download Failed", message: status.error, danger: true });
            }
          } else {
            fetchModels();
            const companion = pendingCompanionDownloadRef.current;
            pendingCompanionDownloadRef.current = null;
            if (companion?.url && companion?.filename && !allModelNames.includes(companion.filename)) {
              setTimeout(() => {
                downloadByUrl(
                  companion.url,
                  companion.filename,
                  null,
                  { skipExistingConfirm: true }
                );
              }, 500);
            }
          }
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }, 1000);
  };

  const handleUrlDownloadSubmit = async (e) => {
    e.preventDefault();
    if (!downloadUrl.trim()) return;

    let modelName = activeModelType === "image" ? "model.safetensors" : activeModelType === "text" ? "model.gguf" : activeModelType === "speech" ? "model.bin" : "model.json";
    try {
      const parsed = new URL(downloadUrl.trim());
      modelName = parsed.pathname.split("/").pop() || modelName;
    } catch (_) {
      showAlert({ title: "Invalid URL", message: "Please provide a valid HTTP/HTTPS link.", danger: true });
      return;
    }

    await downloadByUrl(downloadUrl.trim(), modelName);
    setDownloadUrl("");
  };

  const handleLibraryDownload = async (model) => {
    if (downloadingModelId) return;

    if (activeModelType === "speech") {
      const confirmed = await showConfirm({
        title: "Download Speech Model?",
        message: `Download "${model.name}" (${model.size || model.approxSize})?`,
        confirmLabel: "Download",
      });
      if (confirmed) {
        await downloadByUrl(model.url, model.filename);
      }
      return;
    }

    if (activeModelType === "tts") {
      const confirmed = await showConfirm({
        title: "Download TTS Model?",
        message: `Install "${model.name}"? Kokoro model files are cached on first generation.`,
        confirmLabel: "Install",
      });
      if (confirmed) {
        await downloadByUrl(model.id || model.url, model.filename);
      }
      return;
    }

    if (model.backendType === "openvino-npu") {
      const confirmed = await showConfirm({
        title: "Download OpenVINO Model?",
        message: `Download "${model.name}" (~${model.approxSize})? OpenVINO models are downloaded folder-by-folder via python script.`,
        confirmLabel: "Download",
      });
      if (!confirmed) return;
      try {
        await downloadOpenVinoModel(model.id);
        startProgressPolling(model.name);
      } catch (err) {
        showAlert({ title: "Download Failed", message: err.message, danger: true });
      }
      return;
    }

    const hasMainModel = modelNames.includes(model.filename);
    const hasProjector = !model.projectorFilename || allModelNames.includes(model.projectorFilename);
    if (hasMainModel && model.projectorUrl && model.projectorFilename && !hasProjector) {
      const confirmed = await showConfirm({
        title: "Download Vision Projector?",
        message: `"${model.name}" is downloaded, but image input needs the matching projector file (${model.projectorFilename}). Download it now?`,
        confirmLabel: "Download Projector",
      });
      if (confirmed) {
        await downloadByUrl(model.projectorUrl, model.projectorFilename, null, { skipExistingConfirm: true });
      }
      return;
    }

    const confirmed = await showConfirm({
      title: "Download Model?",
      message: model.projectorUrl
        ? `Download "${model.name}" (~${model.approxSize}) and its required vision projector?`
        : `Download "${model.name}" (~${model.approxSize})?`,
      confirmLabel: "Download",
    });
    if (confirmed) {
      await downloadByUrl(
        model.url,
        model.filename,
        model.projectorUrl && model.projectorFilename
          ? { url: model.projectorUrl, filename: model.projectorFilename }
          : null
      );
    }
  };

  const handleCancelDownload = async () => {
    try {
      await cancelModelDownload();
      setDownloadingModelId(null);
      setDownloadProgress(0);
      setDownloadSpeed("");
    } catch (err) {
      console.error(err);
    }
  };

  const checkVramAndLoad = async (modelId, options = {}) => {
    if (!options.skipActiveGuard && blockLoadIfOtherRuntimeActive(modelId, "image")) {
      return;
    }

    const modelInfo = getLocalModelInfo(modelId);
    if (!modelInfo) {
      await performLoadModel(modelId);
      return;
    }

    const isOpenVinoSelected = constraints.backendType === "openvino-npu";
    const isOpenVinoModel = modelInfo.backendType === "openvino-npu";
    const isCoreMLModel = modelInfo.format === "CoreML" || modelInfo.backendType === "apple-npu";
    const isStandardWeights = /\.(safetensors|ckpt|gguf)$/i.test(modelId) || (!isOpenVinoModel && !isCoreMLModel);
    if (isOpenVinoSelected && isStandardWeights) {
      const gpuBackend = backendOptions?.options?.find((backend) =>
        ["vulkan", "cuda", "rocm", "metal"].includes(backend.id)
      );
      const cpuBackend = backendOptions?.options?.find((backend) => backend.id === "cpu");
      const targetBackend = gpuBackend || cpuBackend;

      if (!targetBackend) {
        await showAlert({
          title: "Switch Backend Required",
          message: `"${modelId}" is a standard weights file. OpenVINO NPU can only load downloaded OpenVINO model folders, and no GPU or CPU backend is currently installed.`,
          danger: true,
        });
        return;
      }

      const confirmed = await showConfirm({
        title: "Switch Accelerator?",
        message: `"${modelId}" cannot load on OpenVINO NPU. Switch to ${targetBackend.label} and load it there?`,
        confirmLabel: `Switch to ${targetBackend.label}`,
        cancelLabel: "Cancel",
      });
      if (!confirmed) return;

      const nextConstraints = {
        ...constraints,
        backendType: targetBackend.id,
        useGpu: targetBackend.id !== "cpu",
      };
      setConstraints(nextConstraints);
      await performLoadModel(modelId, nextConstraints);
      return;
    }

    const totalSizeBytes = Number(modelInfo.sizeBytes) || 0;
    if (totalSizeBytes <= 0) {
      await performLoadModel(modelId);
      return;
    }

    const freeVramGb = Number(telemetry.vram_total_gb - telemetry.vram_used_gb) || 0;
    const modelSizeGb = totalSizeBytes / (1024 ** 3);
    const hasNvidiaGpu = Boolean(telemetry.gpu_name && telemetry.gpu_name.toLowerCase().includes("nvidia"));
    
    const isCpuOnlyBackend = constraints.backendType === "cpu" || constraints.useGpu === false;

    if (hasNvidiaGpu && !isCpuOnlyBackend && modelInfo.backendType !== "openvino-npu" && modelInfo.format !== "CoreML") {
      const safetyMarginGb = 0.8;
      if (modelSizeGb + safetyMarginGb > freeVramGb) {
        setVramWarning({
          modelId,
          modelSizeGb,
          freeVramGb,
          totalVramGb: telemetry.vram_total_gb,
        });
        return;
      }
    }
    await performLoadModel(modelId);
  };

  const loadTextModel = async (modelId) => {
    setLoadingModelId(modelId);
    setModelLoadProgress({
      progress: 40,
      phase: "Starting llama.cpp server...",
      speed: "",
      current: 0,
      total: 0,
      model: modelId,
      backendMode: "",
      backendBinary: "",
      device: "",
    });
    try {
      const cores = textSettings?.threads || specs?.cpu_cores_physical || 4;
      const context = textSettings?.contextSize ?? 0;
      await startLlm(modelId, {
        threads: cores,
        contextSize: context,
        gpuLayers: -1,
        preferredBackend: textSettings?.preferredBackend
      });
      setActiveLlmModel(modelId);
      setLlmRunning(true);
    } catch (err) {
      showAlert({ title: "Model Load Failed", message: err.message || String(err), danger: true });
    } finally {
      setModelLoadProgress(null);
      setLoadingModelId(null);
    }
  };

  const loadSpeechModel = async (modelId) => {
    setLoadingModelId(modelId);
    setModelLoadProgress({
      progress: 30,
      phase: "Starting whisper.cpp speech runtime...",
      speed: "",
      current: 0,
      total: 0,
      model: modelId,
      backendMode: "",
      backendBinary: "",
      device: "",
    });
    try {
      await startSpeech(modelId, { threads: textSettings?.threads || specs?.cpu_cores_physical || 4 });
      setActiveSpeechModel(modelId);
      setSpeechRunning(true);
    } catch (err) {
      showAlert({ title: "Speech Model Load Failed", message: err.message || String(err), danger: true });
    } finally {
      setModelLoadProgress(null);
      setLoadingModelId(null);
    }
  };

  const loadTtsModel = async (modelId) => {
    setLoadingModelId(modelId);
    setModelLoadProgress({
      progress: 30,
      phase: "Starting Kokoro ONNX TTS runtime...",
      speed: "",
      current: 0,
      total: 0,
      model: modelId,
      backendMode: "",
      backendBinary: "",
      device: "",
    });
    try {
      await startTts(modelId);
      setActiveTtsModel(modelId);
      setTtsRunning(true);
    } catch (err) {
      showAlert({ title: "TTS Model Load Failed", message: err.message || String(err), danger: true });
    } finally {
      setModelLoadProgress(null);
      setLoadingModelId(null);
    }
  };

  const handleLoadModel = async (modelId) => {
    if (blockLoadIfOtherRuntimeActive(modelId, activeModelType)) {
      return;
    }

    if (activeModelType === "image") {
      await checkVramAndLoad(modelId);
    } else if (activeModelType === "text") {
      await loadTextModel(modelId);
    } else if (activeModelType === "speech") {
      await loadSpeechModel(modelId);
    } else {
      await loadTtsModel(modelId);
    }
  };

  const performLoadModel = async (modelId, forcedConstraints = null) => {
    const isTauriDesktop = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
    const backendStatus = await getBackendStatus();
    const backendPort = backendStatus?.port || 8080;
    
    if (!isTauriDesktop && !isLocalServerMode()) {
      const isAlreadyRunning = await pingServer();
      const modelInfo = getLocalModelInfo(modelId);
      const isOpenVinoModel = modelInfo?.backendType === "openvino-npu";
      const cmd = isOpenVinoModel
        ? `Run the platform launcher and load "${modelId}" from Model Manager on a configured Intel NPU machine.`
        : `.\\backend\\win\\vulkan\\sd-vulkan.exe --listen-port ${backendPort} --model .\\models\\${modelId} --threads 8`;
      
      if (isAlreadyRunning) {
        if (await showConfirm({ title: "Web Browser Mode", message: `To load "${modelId}" on the active GPU server, restart your terminal backend with:\n\n${cmd}\n\nUpdate the UI status anyway?`, confirmLabel: "Update UI" })) {
          setActiveModel(modelId);
          setServerRunning(true);
        }
      } else {
        if (await showConfirm({ title: "Backend Not Running", message: `C++ backend server is not running on port ${backendPort}.\n\nTo run locally, start:\n\n${cmd}\n\nProceed in Simulation Mode instead?`, confirmLabel: "Proceed" })) {
          setActiveModel(modelId);
          setServerRunning(false);
        }
      }
      return;
    }

    cancelLoadRef.current = false;
    setLoadingModelId(modelId);
    setModelLoadProgress({
      progress: 0,
      phase: "Starting backend...",
      speed: "",
      current: 0,
      total: 0,
      model: modelId,
      backendMode: "",
      backendBinary: "",
      device: "",
    });
    try {
      const modelInfo = getLocalModelInfo(modelId);
      const isCoreMLModel = modelInfo?.format === "CoreML" || modelInfo?.backendType === "apple-npu";
      const activeConstraints = forcedConstraints || constraints;
      const loadConstraints = isCoreMLModel
        ? {
            ...activeConstraints,
            backendType: "apple-npu",
            useGpu: true,
            width: 512,
            height: 512,
            steps: activeConstraints.steps || 20,
            cfgScale: Number(activeConstraints.cfgScale) > 1 ? activeConstraints.cfgScale : 7,
          }
        : modelInfo?.backendType === "openvino-npu"
        ? {
            ...activeConstraints,
            backendType: "openvino-npu",
            useGpu: true,
            width: activeConstraints.width >= 1024 ? 1024 : 512,
            height: activeConstraints.height >= 1024 ? 1024 : 512,
            steps: Math.max(1, Math.min(8, activeConstraints.steps || 4)),
            cfgScale: activeConstraints.cfgScale || 1,
          }
        : activeConstraints;
      
      const response = await startServer(modelId, loadConstraints);
      console.log(response);
      
      let isReady = false;
      let crashError = null;
      let readyStatus = null;
      const isOpenVinoModel = modelInfo?.backendType === "openvino-npu";
      const maxStartupPolls = (isOpenVinoModel || isCoreMLModel) ? 1200 : 240;
      for (let i = 0; i < maxStartupPolls; i++) {
        if (cancelLoadRef.current) {
          crashError = "Model load cancelled by the user.";
          break;
        }
        const status = await getBackendStatus();
        if (status.loading) {
          setModelLoadProgress({
            progress: status.loading.progress || 0,
            phase: status.loading.phase || "Loading model...",
            speed: status.loading.speed || "",
            current: status.loading.current || 0,
            total: status.loading.total || 0,
            model: status.loading.model || modelId,
            backendMode: status.loading.backendMode || status.settings?.backendMode || "",
            backendBinary: status.loading.backendBinary || status.settings?.backendBinary || "",
            device: status.loading.device || status.settings?.backendDevice || "",
          });
        }
        if (status.ready) {
          isReady = true;
          readyStatus = status;
          break;
        }
        if (status.error) {
          crashError = status.error;
          break;
        }
        if (!status.running && !status.loading?.active && i > 3) {
          crashError = "The backend process terminated immediately on startup.";
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (isReady) {
        const loadedModelId = readyStatus?.settings?.backendType === "openvino-npu"
          ? (readyStatus.settings.model || readyStatus.loading?.model || modelId)
          : modelId;
        setModelLoadProgress((prev) => ({
          ...(prev || {}),
          progress: 100,
          phase: "Model ready",
          speed: "",
          current: prev?.current || 0,
          total: prev?.total || 0,
          model: loadedModelId,
        }));
        setActiveModel(loadedModelId);
        setServerRunning(true);
      } else {
        throw new Error(crashError || `Model server failed to respond on port ${backendPort}.`);
      }
    } catch (e) {
      console.error("Failed to load model:", e);
      if (e.message !== "Model load cancelled by the user.") {
        showAlert({ title: "Model Load Failed", message: e.message || String(e), danger: true });
      }
    } finally {
      setTimeout(() => setModelLoadProgress(null), 800);
      setLoadingModelId(null);
    }
  };

  const handleUnloadThenLoad = async () => {
    const pendingLoad = pendingLoadModel;
    const nextModel = pendingLoad?.modelId;
    const targetType = pendingLoad?.targetType;
    setPendingLoadModel(null);
    await handleUnloadModel(pendingLoad?.activeRuntime);
    if (nextModel) {
      if (targetType === "image") {
        await checkVramAndLoad(nextModel, { skipActiveGuard: true });
      } else if (targetType === "text") {
        await loadTextModel(nextModel);
      } else if (targetType === "speech") {
        await loadSpeechModel(nextModel);
      } else if (targetType === "tts") {
        await loadTtsModel(nextModel);
      }
    }
  };

  const handleUnloadPendingOnly = async () => {
    const pendingLoad = pendingLoadModel;
    setPendingLoadModel(null);
    await handleUnloadModel(pendingLoad?.activeRuntime);
  };

  const handleUnloadModel = async (runtimeOverride = null) => {
    const runtime = runtimeOverride?.type ? runtimeOverride : getRuntimeForType(activeModelType);
    if (!runtime || isUnloading) return;

    if (runtime.type === "image") {
      if (isUnloading) return;
      setIsUnloading(true);
      setUnloadProgress({ progress: 10, phase: "Stopping backend process..." });

      const poll = setInterval(async () => {
        try {
          const status = await getBackendStatus();
          if (status.unloading?.active) {
            setUnloadProgress({
              progress: status.unloading.progress || 50,
              phase: status.unloading.phase || "Unloading model...",
            });
          } else {
            setUnloadProgress((prev) => ({
              progress: Math.min(95, prev.progress + 10),
              phase: prev.phase || "Unloading model...",
            }));
          }
        } catch (_) {}
      }, 300);

      try {
        await stopServer();
        setUnloadProgress({ progress: 100, phase: "Model unloaded" });
        setActiveModel(null);
        setPendingLoadModel(null);
        setServerRunning(false);
      } catch (e) {
        console.error(e);
        showAlert({ title: "Unload Failed", message: e.message || String(e), danger: true });
      } finally {
        clearInterval(poll);
        setTimeout(() => {
          setIsUnloading(false);
          setUnloadProgress({ progress: 0, phase: "" });
        }, 500);
      }
    } else if (runtime.type === "text") {
      setIsUnloading(true);
      setUnloadProgress({ progress: 50, phase: "Stopping llama.cpp backend process..." });
      try {
        await stopLlm();
        setActiveLlmModel(null);
        setLlmRunning(false);
      } catch (e) {
        showAlert({ title: "Unload Failed", message: e.message || String(e), danger: true });
      } finally {
        setIsUnloading(false);
        setUnloadProgress({ progress: 0, phase: "" });
      }
    } else if (runtime.type === "speech") {
      setIsUnloading(true);
      setUnloadProgress({ progress: 50, phase: "Stopping whisper.cpp speech runtime..." });
      try {
        await stopSpeech();
        setActiveSpeechModel(null);
        setSpeechRunning(false);
      } catch (e) {
        showAlert({ title: "Unload Failed", message: e.message || String(e), danger: true });
      } finally {
        setIsUnloading(false);
        setUnloadProgress({ progress: 0, phase: "" });
      }
    } else {
      setIsUnloading(true);
      setUnloadProgress({ progress: 50, phase: "Stopping Kokoro TTS runtime..." });
      try {
        await stopTts();
        setActiveTtsModel(null);
        setTtsRunning(false);
      } catch (e) {
        showAlert({ title: "Unload Failed", message: e.message || String(e), danger: true });
      } finally {
        setIsUnloading(false);
        setUnloadProgress({ progress: 0, phase: "" });
      }
    }
  };

  const handleDeleteModel = async (filename) => {
    if (await showConfirm({
      title: "Delete Model?",
      message: `Delete "${filename}" from your drive?`,
      confirmLabel: "Delete",
      danger: true,
    })) {
      try {
        if (activeModelType === "image") {
          await deleteModel(filename);
          if (activeModel === filename) {
            await handleUnloadModel();
          }
        } else if (activeModelType === "text") {
          await deleteLlmModel(filename);
          if (activeLlmModel === filename) {
            await handleUnloadModel();
          }
        } else if (activeModelType === "speech") {
          await deleteSpeechModel(filename);
          if (activeSpeechModel === filename) {
            await handleUnloadModel();
          }
        } else {
          await deleteTtsModel(filename);
          if (activeTtsModel === filename) {
            await handleUnloadModel();
          }
        }
        await fetchModels();
      } catch (err) {
        console.error("Failed to delete model:", err);
        showAlert({ title: "Delete Failed", message: err.message || String(err), danger: true });
      }
    }
  };

  const executeImport = async (sourcePath, displayName) => {
    const controller = new AbortController();
    setImportAbortController(controller);
    setImportProgress(0);
    setImportInfo({
      filename: displayName,
      speed: "0.0",
      eta: 0,
      status: "Initiating file copy..."
    });

    try {
      if (activeModelType === "image") {
        await importModelFile(sourcePath, (progressData) => {
          setImportProgress(Math.round(progressData.progress));
          setImportInfo({
            filename: progressData.filename,
            speed: progressData.speed_mb_s.toFixed(1),
            eta: Math.round(progressData.eta_secs),
            status: progressData.status
          });
        }, controller.signal);
      } else if (activeModelType === "text") {
        await importLlmModel(sourcePath, (progressData) => {
          setImportProgress(Math.round(progressData.progress));
          setImportInfo({
            filename: progressData.filename,
            speed: progressData.speed_mb_s.toFixed(1),
            eta: Math.round(progressData.eta_secs),
            status: progressData.status
          });
        }, controller.signal);
      } else if (activeModelType === "speech") {
        await importSpeechModel(sourcePath, (progressData) => {
          setImportProgress(Math.round(progressData.progress));
          setImportInfo({
            filename: progressData.filename,
            speed: progressData.speed_mb_s.toFixed(1),
            eta: Math.round(progressData.eta_secs),
            status: progressData.status
          });
        }, controller.signal);
      } else {
        await importTtsModel(sourcePath, (progressData) => {
          setImportProgress(Math.round(progressData.progress));
          setImportInfo({
            filename: progressData.filename,
            speed: progressData.speed_mb_s.toFixed(1),
            eta: Math.round(progressData.eta_secs),
            status: progressData.status
          });
        }, controller.signal);
      }

      await fetchModels();
    } catch (err) {
      console.error("Import failed:", err);
      if (err.name !== "AbortError") {
        showAlert({ title: "Import Failed", message: err.message || String(err), danger: true });
      }
    } finally {
      setImportProgress(null);
      setImportAbortController(null);
    }
  };

  const handleCancelImport = () => {
    if (importAbortController) {
      importAbortController.abort();
    }
  };

  const handleImportFile = (e) => {
    const file = e.target.files[0];
    if (file) {
      executeImport(file, file.name);
    }
    e.target.value = "";
  };

  const isUrlDownloading = Boolean(downloadingModelId);

  return (
    <div className="workspace-area">
      <div className="workspace-title-section">
        <h2 className="workspace-title">Model Manager</h2>
        <p className="workspace-subtitle">
          Manage local files and download recommended weights directly to your local models folder.
        </p>
      </div>

      {/* Tab Selector for Image vs Text */}
      <div style={{ display: "flex", gap: "12px", borderBottom: "1px solid var(--border-color)", paddingBottom: "16px", marginBottom: "20px" }}>
        <button
          className={`m3-btn ${activeModelType === "image" ? "m3-btn-filled" : "m3-btn-outlined"}`}
          onClick={() => setActiveModelType("image")}
          style={{ height: "40px", padding: "0 20px" }}
        >
          Image Models (SD)
        </button>
        <button
          className={`m3-btn ${activeModelType === "text" ? "m3-btn-filled" : "m3-btn-outlined"}`}
          onClick={() => setActiveModelType("text")}
          style={{ height: "40px", padding: "0 20px" }}
        >
          Text Models (GGUF)
        </button>
        <button
          className={`m3-btn ${activeModelType === "speech" ? "m3-btn-filled" : "m3-btn-outlined"}`}
          onClick={() => setActiveModelType("speech")}
          style={{ height: "40px", padding: "0 20px" }}
        >
          Speech Models (Whisper)
        </button>
        <button
          className={`m3-btn ${activeModelType === "tts" ? "m3-btn-filled" : "m3-btn-outlined"}`}
          onClick={() => setActiveModelType("tts")}
          style={{ height: "40px", padding: "0 20px" }}
        >
          TTS Models (Kokoro)
        </button>
      </div>



      {/* Active Model Status Tonal Box */}
      {activeModelType === "image" && activeModel && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", background: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ fontWeight: 700 }}>Active Model: {activeModel}</h4>
              <p style={{ fontSize: "0.85rem", marginTop: "2px", opacity: 0.9 }}>
                The local C++ stable-diffusion server is running. Real-time telemetry is displaying performance status in the top bar.
              </p>
              {(backendInfo.backendMode || backendInfo.backendDevice || backendInfo.backendBinary) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" }}>
                  {backendInfo.backendMode && (
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <HardDrive size={14} />
                      <span>Loaded on {backendInfo.backendMode}</span>
                    </span>
                  )}
                  {backendInfo.backendDevice && (
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <span>{backendInfo.backendDevice}</span>
                    </span>
                  )}
                  {backendInfo.backendBinary && (
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <span>{backendInfo.backendBinary}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeModelType === "text" && activeLlmModel && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", background: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ fontWeight: 700 }}>Active Text Model: {activeLlmModel}</h4>
              <p style={{ fontSize: "0.85rem", marginTop: "2px", opacity: 0.9 }}>
                The local C++ llama.cpp server is running. Chat requests can be sent via the Text Chat interface.
              </p>
              {backendInfo.llmBackendMode && (
                <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                  <span className="status-chip" style={{ cursor: "default", background: "rgba(255,255,255,0.15)", color: "inherit", border: "1px solid rgba(255,255,255,0.2)" }}>
                    <span>{backendInfo.llmBackendMode}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeModelType === "speech" && activeSpeechModel && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", background: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ fontWeight: 700 }}>Active Speech Model: {activeSpeechModel}</h4>
              <p style={{ fontSize: "0.85rem", marginTop: "2px", opacity: 0.9 }}>
                The local whisper.cpp runtime is ready. Speech Transcriber can process WAV recordings and uploads.
              </p>
              {backendInfo.speechBackendMode && (
                <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                  <span className="status-chip" style={{ cursor: "default", background: "rgba(255,255,255,0.15)", color: "inherit", border: "1px solid rgba(255,255,255,0.2)" }}>
                    <span>{backendInfo.speechBackendMode}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeModelType === "tts" && activeTtsModel && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", background: "var(--md-sys-color-primary-container)", color: "var(--md-sys-color-on-primary-container)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ fontWeight: 700 }}>Active TTS Model: {activeTtsModel}</h4>
              <p style={{ fontSize: "0.85rem", marginTop: "2px", opacity: 0.9 }}>
                The local Kokoro ONNX runtime is ready. Text to Speech can generate WAV narration.
              </p>
              {backendInfo.ttsBackendMode && (
                <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                  <span className="status-chip" style={{ cursor: "default", background: "rgba(255,255,255,0.15)", color: "inherit", border: "1px solid rgba(255,255,255,0.2)" }}>
                    <span>{backendInfo.ttsBackendMode}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Loading Progress Bar */}
      {modelLoadProgress && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", marginTop: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h4 style={{ fontWeight: 600 }}>Loading Weights: {modelLoadProgress.model}</h4>
            <button className="m3-btn m3-btn-error" style={{ height: "34px", padding: "0 14px" }} onClick={handleCancelLoad}>
              <Square size={14} />
              <span>Cancel Load</span>
            </button>
          </div>
          <div className="model-progress-section" style={{ margin: "12px 0 6px 0" }}>
            <div className="model-progress-label">
              <span>
                {modelLoadProgress.phase}
                {modelLoadProgress.speed ? ` (${modelLoadProgress.speed})` : ""}
              </span>
              <span>
                {modelLoadProgress.total > 0
                  ? `Loaded ${modelLoadProgress.current} / ${modelLoadProgress.total} tensors`
                  : `${Math.round(modelLoadProgress.progress)}%`}
              </span>
            </div>
            <div className="model-progress-bar">
              <div className="model-progress-fill" style={{ width: `${Math.min(100, Math.max(0, modelLoadProgress.progress))}%`, transition: "width 0.2s ease" }}></div>
            </div>
            {(modelLoadProgress.backendMode || modelLoadProgress.device) && (
              <div style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginTop: "6px", lineHeight: "1.4" }}>
                <div>
                  Initializing {modelLoadProgress.backendMode || "backend"}
                  {modelLoadProgress.device ? ` • ${modelLoadProgress.device}` : ""}
                </div>
                {(modelLoadProgress.backendMode === "Apple NPU" || modelLoadProgress.backendMode === "Apple Neural Engine (NPU)") && (
                  <div style={{ color: "var(--md-sys-color-primary)", marginTop: "4px", fontWeight: "500" }}>
                    ⚠️ Note: The first time loading this model, compilation on the Apple Neural Engine (NPU) can take 3–4 minutes. Subsequent loads will be almost instant.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Unloading Progress Bar */}
      {isUnloading && activeModelType === "image" && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-error)", marginTop: "24px" }}>
          <h4 style={{ fontWeight: 600 }}>{unloadProgress.phase || "Unloading active model..."}</h4>
          <div className="model-progress-section" style={{ margin: "12px 0 0 0" }}>
            <div className="model-progress-bar">
              <div className="model-progress-fill" style={{ width: `${unloadProgress.progress}%`, background: "var(--md-sys-color-error)", transition: "width 0.15s ease" }}></div>
            </div>
          </div>
        </div>
      )}

      {/* Detected Local Models Section */}
      <div className="m3-card" style={{ marginTop: "24px" }}>
        <h3 className="m3-card-title">
          <Database size={18} style={{ color: "var(--md-sys-color-primary)" }} />
          Local {activeModelType === "image" ? "Image" : activeModelType === "text" ? "Text" : activeModelType === "speech" ? "Speech" : "TTS"} Models ({displayedLocalModels.length})
        </h3>
        
        {isLoadingModels ? (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", padding: "24px 0", color: "var(--md-sys-color-outline)" }}>
            <RefreshCw className="progress-spinner" size={16} />
            <span style={{ fontSize: "0.9rem" }}>Scanning models folder...</span>
          </div>
        ) : displayedLocalModels.length === 0 ? (
          <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-outline)", textAlign: "center", padding: "16px 0" }}>
            {activeModelType === "image"
              ? "No image models detected in app/models/. Download from the library below or import a file."
              : activeModelType === "text"
              ? "No text models detected in app/llm-models/. Download from the library below or import a file."
              : activeModelType === "speech"
              ? "No speech models detected in app/speech-models/. Download from the library below or import a .bin file."
              : "No TTS models detected in app/tts-models/. Install Kokoro from the library below or import a .json manifest."}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {displayedLocalModels.map((model) => {
              const filename = model.filename;
              const isActive = activeModelType === "image" ? activeModel === filename : activeModelType === "text" ? activeLlmModel === filename : activeModelType === "speech" ? activeSpeechModel === filename : activeTtsModel === filename;
              
              return (
                <div 
                  key={filename} 
                  style={{ 
                    display: "flex", 
                    justifyContent: "space-between", 
                    alignItems: "center", 
                    padding: "12px 16px", 
                    background: isActive ? "var(--md-sys-color-primary-container)" : "var(--md-sys-color-surface-variant)",
                    color: isActive ? "var(--md-sys-color-on-primary-container)" : "var(--md-sys-color-on-surface-variant)",
                    borderRadius: "var(--md-shape-corner-medium)",
                    border: "1px solid var(--md-sys-color-outline-variant)"
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{filename}</span>
                    <span style={{ fontSize: "0.75rem", opacity: 0.8 }}>
                      {activeModelType === "image"
                        ? (model.backendType === "openvino-npu" ? "OpenVINO NPU Model" : model.format || "Local Weights File")
                        : activeModelType === "text"
                        ? "llama.cpp GGUF Model"
                        : activeModelType === "speech"
                        ? `${model.language || "Whisper"} Model`
                        : "Kokoro ONNX Model"
                      } • {model.size || formatBytes(model.sizeBytes)}
                    </span>
                  </div>
                  
                  <div style={{ display: "flex", gap: "8px" }}>
                    {isActive ? (
                      <button className="m3-btn m3-btn-error" style={{ height: "36px", padding: "0 16px" }} onClick={() => handleUnloadModel()} disabled={isUnloading}>
                        {isUnloading ? <RefreshCw className="progress-spinner" size={14} /> : <Trash2 size={14} />}
                        <span>{isUnloading ? "Unloading" : "Unload"}</span>
                      </button>
                    ) : (
                      <>
                        <button 
                          className="m3-btn m3-btn-filled" 
                          style={{ height: "36px", padding: "0 16px" }} 
                          onClick={() => handleLoadModel(filename)}
                          disabled={isBusy}
                        >
                          {loadingModelId === filename ? (
                            <RefreshCw className="progress-spinner" size={14} />
                          ) : (
                            <Database size={14} />
                          )}
                          <span>{loadingModelId === filename ? "Loading" : "Load"}</span>
                        </button>
                        <button
                          className="m3-btn m3-btn-error"
                          style={{ height: "36px", width: "36px", padding: 0, minWidth: "36px" }}
                          onClick={() => handleDeleteModel(filename)}
                          disabled={isBusy}
                          title="Delete from models folder"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="workspace-title-section" style={{ marginTop: "32px", marginBottom: "16px" }}>
        <h3 className="m3-card-title">
          <Library size={20} style={{ color: "var(--md-sys-color-primary)" }} />
          {activeModelType === "text" ? "Hugging Face Model Library" : activeModelType === "speech" ? "Speech Model Library" : activeModelType === "tts" ? "TTS Model Library" : "Model Library"}
        </h3>
      </div>

      {activeModelType === "text" && (
        <div className="model-discovery-controls">
          <div className="model-search-box">
            <Search size={18} />
            <input
              type="search"
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              placeholder="Search Hugging Face GGUF models..."
              aria-label="Search Hugging Face models"
            />
            {modelSearch && (
              <button type="button" onClick={() => setModelSearch("")} title="Clear search" aria-label="Clear model search">
                <X size={16} />
              </button>
            )}
          </div>
          <div className="model-filter-row" aria-label="Model filters">
            {MODEL_FILTERS.map((filter) => {
              const selected = selectedFilters.includes(filter.id);
              return (
                <button
                  key={filter.id}
                  type="button"
                  className={`model-filter-chip ${selected ? "selected" : ""}`}
                  onClick={() => toggleModelFilter(filter.id)}
                  aria-pressed={selected}
                >
                  {filter.label}
                  {selected && <X size={14} />}
                </button>
              );
            })}
            {selectedFilters.length > 0 && (
              <button type="button" className="model-filter-clear" onClick={() => setSelectedFilters([])}>
                Clear filters
              </button>
            )}
          </div>
          {isSearchingModels && (
            <div className="model-discovery-loading">
              <RefreshCw className="progress-spinner" size={16} />
              <span>Loading models from Hugging Face...</span>
            </div>
          )}
          {modelSearchError && (
            <div className="model-search-warning">
              {modelSearchError} Showing the built-in fallback catalog.
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {activeModelType === "text" && hasHuggingFaceResults && !isSearchingModels && displayedHuggingFaceModels.length === 0 && (
          <div className="m3-card model-search-empty">
            No downloadable single-file GGUF models matched this search and filter combination.
          </div>
        )}
        {visibleModelLibrary.filter((section) => section.items.length > 0).map((section) => (
          <div key={section.group} className="m3-card" style={{ margin: 0 }}>
            <h4 style={{ fontWeight: 700, marginBottom: "12px" }}>{section.group}</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
              {section.items.map((model) => {
                const hasMainModel = modelNames.includes(model.filename);
                const hasProjector = !model.projectorFilename || allModelNames.includes(model.projectorFilename);
                const needsProjector = Boolean(hasMainModel && model.projectorFilename && !hasProjector);
                const installed = hasMainModel && hasProjector;
                const downloading = downloadingModelId === model.filename || downloadingModelId === model.projectorFilename || downloadingModelId === `${model.filename}.zip`;
                const systemTier = getHardwareTier(specs);
                const isRecommended = typeof model.recommendedFit === "boolean"
                  ? model.recommendedFit
                  : model.recommendedTiers && model.recommendedTiers.includes(systemTier);
                const fitLabel = model.fitLabel || "Recommended Fit";
                return (
                  <div key={`${model.id || section.group}:${model.filename}`} style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", background: "var(--md-sys-color-surface-variant)", border: "1px solid var(--md-sys-color-outline-variant)", borderRadius: "var(--md-shape-corner-medium)" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <span style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        {model.name}
                        {isRecommended && (
                          <span title={model.fitReason || `Recommended for ${systemTier} tier hardware`} style={{
                            fontSize: "0.68rem", 
                            color: "#2e7d32", 
                            background: "#e8f5e9", 
                            padding: "2px 6px", 
                            borderRadius: "4px", 
                            fontWeight: "bold",
                            border: "1px solid #c8e6c9" 
                          }}>
                            [{fitLabel}]
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)" }}>
                        {model.format} {model.resolution && model.resolution !== "N/A" && `• ${model.resolution}`}
                      </span>
                      {model.size && model.size !== "Unknown" ? (
                        <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-on-surface-variant)", fontWeight: 600 }}>
                          File size: {model.size}
                        </span>
                      ) : model.approxSize ? (
                        <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-on-surface-variant)", fontWeight: 600 }}>
                          File size: approx. {model.approxSize}
                        </span>
                      ) : null}
                    </div>
                    <p style={{ fontSize: "0.78rem", color: "var(--md-sys-color-on-surface-variant)", lineHeight: 1.35, margin: 0 }}>
                      {model.notes}
                    </p>
                    {downloading && (
                      <div className="model-progress-section" style={{ marginTop: "2px" }}>
                        <div className="model-progress-label">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                            <span className="loading-dot"></span>
                            Downloading
                          </span>
                          <span>{downloadProgress > 0 ? `${downloadProgress}%` : "Preparing"}</span>
                        </div>
                        <div className="model-progress-bar">
                          <div className="model-progress-fill" style={{ width: `${Math.min(100, Math.max(0, downloadProgress))}%`, transition: "width 0.2s ease" }}></div>
                        </div>
                        {downloadSpeed && (
                          <div style={{ fontSize: "0.7rem", color: "var(--md-sys-color-outline)", marginTop: "4px" }}>
                            {downloadSpeed}
                          </div>
                        )}
                      </div>
                    )}
                    <button
                      className={installed ? "m3-btn m3-btn-tonal" : "m3-btn m3-btn-filled"}
                      style={{ height: "36px", marginTop: "auto" }}
                      onClick={() => handleLibraryDownload(model)}
                      disabled={installed || downloadingModelId !== null}
                    >
                      {installed ? <HardDrive size={14} /> : downloading ? <RefreshCw className="progress-spinner" size={14} /> : <DownloadCloud size={14} />}
                      <span>{installed ? "Downloaded" : downloading ? "Downloading" : needsProjector ? "Download Vision File" : "Download"}</span>
                    </button>
                    <a
                      href={model.pageUrl || model.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        alignSelf: "center",
                        color: "var(--md-sys-color-primary)",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        lineHeight: 1.2,
                        textDecoration: "none",
                      }}
                    >
                      {model.pageUrl ? "View on Hugging Face" : "Save to Downloads folder"}
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {activeModelType === "text" && hasHuggingFaceResults && hasMoreModels && !isSearchingModels && (
          <button
            type="button"
            className="m3-btn m3-btn-tonal model-load-more"
            onClick={handleLoadMoreModels}
            disabled={isLoadingMoreModels}
          >
            {isLoadingMoreModels && <RefreshCw className="progress-spinner" size={16} />}
            <span>{isLoadingMoreModels ? "Loading more models..." : "Load More"}</span>
          </button>
        )}
      </div>

      {/* Local Drag and Drop Importer */}
      <div className="workspace-title-section" style={{ marginTop: "32px", marginBottom: "16px" }}>
        <h3 className="m3-card-title">
          <FolderOpen size={20} style={{ color: "var(--md-sys-color-primary)" }} />
          Local Model Import
        </h3>
      </div>
      {/* Importing Progress Bar */}
      {importProgress !== null && (
        <div className="m3-card" style={{ borderLeft: "4px solid var(--md-sys-color-primary)", marginTop: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <h4 style={{ fontWeight: 600 }}>Copying Model to local folder: {importInfo.filename}</h4>
            <button className="m3-btn m3-btn-error" style={{ height: "34px", padding: "0 14px" }} onClick={handleCancelImport}>
              <Square size={14} />
              <span>Stop Import</span>
            </button>
          </div>
          <div className="model-progress-section" style={{ margin: "12px 0 6px 0" }}>
            <div className="model-progress-label">
              <span>{importInfo.status} ({importInfo.speed} MB/s)</span>
              <span>{importProgress}% ({importInfo.eta}s remaining)</span>
            </div>
            <div className="model-progress-bar">
              <div className="model-progress-fill" style={{ width: `${importProgress}%`, transition: "width 0.15s ease" }}></div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px", marginTop: "16px" }}>
        <label className="import-box" style={{ margin: 0, height: "100%", justifyContent: "center" }}>
          <input
            type="file"
            style={{ display: "none" }}
            accept={activeModelType === "image" ? ".safetensors,.ckpt" : activeModelType === "text" ? ".gguf" : activeModelType === "speech" ? ".bin" : ".json"}
            onChange={handleImportFile}
            disabled={importProgress !== null}
          />
          <FolderOpen className="import-icon" />
          <span style={{ fontWeight: 600 }}>Choose weights file</span>
          <span style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", textAlign: "center" }}>
            Select {activeModelType === "image" ? "`.safetensors` or `.ckpt` weights." : activeModelType === "text" ? "`.gguf` weights." : activeModelType === "speech" ? "`whisper.cpp .bin` weights." : "`Kokoro .json` manifest."}
          </span>
        </label>

        <div className="m3-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center", margin: 0, padding: "20px" }}>
          <h4 style={{ fontWeight: 600, marginBottom: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <DownloadCloud size={16} />
            Download Model from URL
          </h4>
          <p style={{ fontSize: "0.75rem", color: "var(--md-sys-color-outline)", marginBottom: "12px" }}>
            Download any {activeModelType === "image" ? "Safetensors" : activeModelType === "text" ? "GGUF" : activeModelType === "speech" ? "Whisper .bin" : "Kokoro manifest"} model from Hugging Face directly to your models folder.
          </p>
          {isUrlDownloading ? (
            <div className="model-progress-section" style={{ marginTop: "0px" }}>
              <div className="model-progress-label">
                <span style={{ fontSize: "0.75rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "200px" }} title={downloadingModelId}>
                  {downloadingModelId}
                </span>
                <span>{downloadProgress}%</span>
              </div>
              <div className="model-progress-bar" style={{ margin: "4px 0" }}>
                <div className="model-progress-fill" style={{ width: `${downloadProgress}%`, transition: "width 0.15s ease" }}></div>
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--md-sys-color-outline)", marginTop: "2px" }}>
                {downloadSpeed}
              </div>
              <button className="m3-btn m3-btn-error" style={{ height: "34px", padding: "0 14px", marginTop: "10px" }} onClick={handleCancelDownload}>
                <Square size={14} />
                <span>Stop Download</span>
              </button>
            </div>
          ) : (
            <form onSubmit={handleUrlDownloadSubmit} style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                className="m3-input"
                style={{ flex: 1, height: "40px" }}
                placeholder="e.g. https://huggingface.co/..."
                value={downloadUrl}
                onChange={(e) => setDownloadUrl(e.target.value)}
                disabled={downloadingModelId !== null}
              />
              <button 
                type="submit" 
                className="m3-btn m3-btn-filled" 
                style={{ height: "40px" }}
                disabled={downloadingModelId !== null}
              >
                Download
              </button>
            </form>
          )}
        </div>
      </div>

      {pendingLoadModel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div className="m3-card" style={{ maxWidth: "460px", width: "100%", margin: 0, border: "1px solid var(--md-sys-color-outline-variant)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <AlertTriangle size={22} style={{ color: "var(--md-sys-color-error)" }} />
              <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Model Already Active</h3>
            </div>
            <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-on-surface-variant)", lineHeight: 1.45, marginBottom: "16px" }}>
              "{pendingLoadModel.activeRuntime?.model}" is already loaded as a {pendingLoadModel.activeRuntime?.label || "model"} model. Unload it before loading "{pendingLoadModel.modelId}" as a {getModelTypeLabel(pendingLoadModel.targetType)} model.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button className="m3-btn m3-btn-outlined" onClick={() => setPendingLoadModel(null)} disabled={isUnloading}>
                Cancel
              </button>
              <button className="m3-btn m3-btn-error" onClick={handleUnloadPendingOnly} disabled={isUnloading}>
                <Trash2 size={14} />
                <span>Unload</span>
              </button>
              <button className="m3-btn m3-btn-filled" onClick={handleUnloadThenLoad} disabled={isUnloading}>
                {isUnloading ? <RefreshCw className="progress-spinner" size={14} /> : <RefreshCw size={14} />}
                <span>Unload and Load</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {vramWarning && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div className="m3-card" style={{ maxWidth: "480px", width: "100%", margin: 0, padding: "24px", border: "1px solid var(--md-sys-color-error)", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.45)", background: "var(--md-sys-color-surface)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <AlertTriangle size={28} style={{ color: "var(--md-sys-color-error)" }} />
              <h3 style={{ fontSize: "1.2rem", fontWeight: 700, margin: 0, color: "var(--md-sys-color-on-surface)" }}>VRAM Limit Exceeded</h3>
            </div>
            <p style={{ fontSize: "0.92rem", color: "var(--md-sys-color-on-surface-variant)", lineHeight: 1.5, marginBottom: "20px", margin: 0 }}>
              The model <strong style={{ color: "var(--md-sys-color-on-surface)" }}>{vramWarning.modelId}</strong> is approximately <strong>{vramWarning.modelSizeGb.toFixed(1)} GB</strong>, which exceeds your currently available GPU VRAM of <strong>{vramWarning.freeVramGb.toFixed(1)} GB free</strong> (out of {vramWarning.totalVramGb.toFixed(1)} GB total).
              <br /><br />
              Loading this model on your GPU may fail, crash the backend, or cause extremely slow generation due to memory spilling.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" }}>
              <button 
                className="m3-btn m3-btn-outlined" 
                onClick={() => setVramWarning(null)}
              >
                Cancel
              </button>
              <button 
                className="m3-btn m3-btn-tonal"
                style={{ borderColor: "var(--md-sys-color-primary)", color: "var(--md-sys-color-primary)" }}
                onClick={async () => {
                  const targetModel = vramWarning.modelId;
                  setVramWarning(null);
                  if (setConstraints) {
                    setConstraints((prev) => ({
                      ...prev,
                      backendType: "cpu",
                      useGpu: false,
                    }));
                  }
                  const cpuConstraints = {
                    ...constraints,
                    backendType: "cpu",
                    useGpu: false,
                  };
                  await performLoadModel(targetModel, cpuConstraints);
                }}
              >
                Load on CPU
              </button>
              <button 
                className="m3-btn m3-btn-error" 
                onClick={async () => {
                  const targetModel = vramWarning.modelId;
                  setVramWarning(null);
                  await performLoadModel(targetModel);
                }}
              >
                Proceed anyway (GPU)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ModelManager);
