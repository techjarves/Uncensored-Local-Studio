import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, Send, Trash2, Square, History, Paperclip, X, ChevronDown, Globe2, Plus } from "lucide-react";
import {
  getDownloadProgress,
  getLlmStatus,
  listLlmModels,
  streamChatWithLlm,
  startLlm,
  stopLlm,
} from "../services/api";

const processMessageContent = (rawText, apiReasoning = "", enableThinking = true) => {
  if (typeof rawText !== "string") {
    return { content: rawText, reasoning: apiReasoning || "" };
  }

  const cleanReasoningControlTags = (value) => String(value || "")
    .replace(/<\|channel\|>thought/g, "")
    .replace(/<\|channel\|>model/g, "")
    .replace(/<\|turn\|>model/g, "")
    .replace(/<\|im_start\|>model/g, "")
    .replace(/<\|think\|>|<\|thought\|>|<thinking>|<thought>/g, "")
    .replace(/<\|\/think\|>|<\|\/thought\|>|<\/thinking>|<\/thought>/g, "")
    .trim();

  const startTags = ["<|channel|>thought", "<|think|>", "<|thought|>", "<thinking>", "<thought>"];
  const endTags = ["<|channel|>model", "<|turn>model", "<|im_start|>model", "</thinking>", "</thought>", "<|/think|>", "<|/thought|>"];

  if (!enableThinking) {
    return { content: cleanReasoningControlTags(rawText), reasoning: "" };
  }

  let startIdx = -1;
  let matchedStartTag = "";

  for (const tag of startTags) {
    const idx = rawText.indexOf(tag);
    if (idx !== -1 && (startIdx === -1 || idx < startIdx)) {
      startIdx = idx;
      matchedStartTag = tag;
    }
  }

  if (startIdx === -1) {
    return { content: cleanReasoningControlTags(rawText), reasoning: "" };
  }

  let endIdx = -1;
  for (const tag of endTags) {
    const idx = rawText.indexOf(tag, startIdx + matchedStartTag.length);
    if (idx !== -1 && (endIdx === -1 || idx < endIdx)) {
      endIdx = idx;
    }
  }

  if (endIdx === -1) {
    const rawReasoning = rawText.substring(startIdx + matchedStartTag.length);
    return { content: "", reasoning: cleanReasoningControlTags(rawReasoning) };
  }

  const rawReasoning = rawText.substring(startIdx + matchedStartTag.length, endIdx);
  const rawContent = rawText.substring(endIdx);

  return {
    content: cleanReasoningControlTags(rawContent),
    reasoning: cleanReasoningControlTags(rawReasoning)
  };
};

function ChatThinkingSection({ reasoning, timeElapsed, isComplete }) {
  const [isExpanded, setIsExpanded] = useState(true);

  const formattedTime = timeElapsed > 0 
    ? ` (${timeElapsed.toFixed(timeElapsed < 10 ? 1 : 0)}s)`
    : "";

  return (
    <div className="chat-thinking-container">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="chat-thinking-header"
      >
        <span className="chat-thinking-title">
          {isComplete ? `Thought process${formattedTime}` : `Thinking...${formattedTime}`}
        </span>
        <ChevronDown
          size={14}
          style={{
            transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
          }}
        />
      </button>
      {isExpanded && (
        <div className="chat-thinking-content">
          {reasoning}
        </div>
      )}
    </div>
  );
}

const messageContainsImage = (message) => (
  Array.isArray(message?.content) &&
  message.content.some((item) => item?.type === "image_url" && item?.image_url?.url)
);

function TextChat({ 
  specs, 
  showAlert, 
  showConfirm, 
  textSettings, 
  setTextSettings, 
  setActiveModel, 
  setServerRunning,
  conversations,
  setConversations,
  activeConversationId,
  setActiveConversationId,
  showHistory,
  setShowHistory,
  saveConversationState,
  setIsLlmLoaded
}) {
  const formatGenerationTime = (seconds) => {
    const value = Number(seconds) || 0;
    if (value < 1) return `${Math.round(value * 1000)} ms`;
    return `${value.toFixed(value < 10 ? 2 : 1)} s`;
  };

  const [models, setModels] = useState([]);
  const [status, setStatus] = useState({ ready: false, running: false, settings: {} });
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [webTimeFilter, setWebTimeFilter] = useState("any");
  const [loadingModel, setLoadingModel] = useState(null);
  const [tokenUsage, setTokenUsage] = useState({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  });

  useEffect(() => {
    if (setIsLlmLoaded) {
      setIsLlmLoaded(status.ready);
    }
  }, [status.ready, setIsLlmLoaded]);

  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setShowModelMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const estimateTokens = (text) => {
    const value = String(text || "").trim();
    if (!value) return 0;
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    return Math.max(wordCount, Math.ceil(value.length / 4));
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const getAutoMaxResponseTokens = (promptTokens, thinkingEnabled) => {
    const contextLimit = Number(status.settings?.contextSize || textSettings?.contextSize || 4096);
    const safetyBuffer = thinkingEnabled ? 768 : 512;
    const preferredMinimum = thinkingEnabled ? 512 : 256;
    const available = contextLimit - promptTokens - safetyBuffer;
    if (available <= 0) return 64;
    return clamp(available, Math.min(preferredMinimum, available), 4096);
  };
  
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const completedDownloadRef = useRef("");
  const loadingModelRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const prevMessagesLengthRef = useRef(0);
  const followGenerationRef = useRef(false);
  const abortControllerRef = useRef(null);
  // rAF batching: accumulate token updates and flush once per frame
  const tokenBufferRef = useRef(null);
  const rafRef = useRef(null);
  // Debounced stats: only update stats pill every 250ms
  const statsDebounceRef = useRef(null);

  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const supportsVision = Boolean(status.ready && status.settings?.supportsVision);
  const supportsThinking = Boolean(status.ready && status.settings?.supportsThinking);
  const deepThinkEnabled = status.ready
    ? status.settings?.enableThinking === true
    : textSettings?.enableThinking === true;
  const visionStatus = status.settings?.visionStatus || "Image input requires a matching mmproj projector file.";

  const resizeComposerInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const maxHeight = 104;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeComposerInput();
  }, [input, resizeComposerInput]);

  const isImage = (file) => {
    return /\.(jpe?g|png|webp)$/i.test(file.name) || file.type.startsWith("image/");
  };

  const isTextFile = (file) => {
    return /\.(txt|md|csv|js|jsx|ts|tsx|py|json|css|html|java|cpp|c|h|rs|go|sh|bat|xml|yaml|yml)$/i.test(file.name) || file.type.startsWith("text/");
  };

  const optimizeImageForVision = (file, maxSide = 1024, quality = 0.92) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const originalDataUrl = reader.result;
      const img = new Image();
      img.onerror = () => reject(new Error(`Could not decode ${file.name}`));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const sendDataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({
          previewDataUrl: originalDataUrl,
          sendDataUrl,
          originalWidth: img.width,
          originalHeight: img.height,
          width,
          height,
        });
      };
      img.src = originalDataUrl;
    };
    reader.readAsDataURL(file);
  });

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    if (!files || files.length === 0) return;

    files.forEach((file) => {
      if (isImage(file)) {
        optimizeImageForVision(file)
          .then((image) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substring(7),
              file,
              type: "image",
              name: file.name,
                dataUrl: image.previewDataUrl,
                sendDataUrl: image.sendDataUrl,
                width: image.width,
                height: image.height,
                originalWidth: image.originalWidth,
                originalHeight: image.originalHeight,
            },
          ]);
          })
          .catch((err) => {
            showAlert({ title: "Image Error", message: err.message || String(err), danger: true });
          });
      } else if (isTextFile(file)) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substring(7),
              file,
              type: "document",
              name: file.name,
              content: event.target.result,
            },
          ]);
        };
        reader.readAsText(file);
      } else {
        showAlert({
          title: "Unsupported File",
          message: `File "${file.name}" is not supported. Please select an image (JPEG, PNG, WEBP) or a text/code file.`,
          danger: true,
        });
      }
    });

    e.target.value = "";
  };

  useEffect(() => {
    loadingModelRef.current = loadingModel;
  }, [loadingModel]);

  // Watch for textSettings changes and reload model if backend mode changed
  const prevGpuLayersRef = useRef(textSettings?.gpuLayers);
  const prevThreadsRef = useRef(textSettings?.threads);
  const prevContextSizeRef = useRef(textSettings?.contextSize);
  
  useEffect(() => {
    const currentGpuLayers = textSettings?.gpuLayers;
    const currentThreads = textSettings?.threads;
    const currentContextSize = textSettings?.contextSize;
    
    // Only reload if model is already loaded and relevant settings changed
    if (status.ready && selectedModel && !loadingModel && !isBusy) {
      const gpuLayersChanged = currentGpuLayers !== prevGpuLayersRef.current;
      const threadsChanged = currentThreads !== prevThreadsRef.current;
      const contextSizeChanged = currentContextSize !== prevContextSizeRef.current;
      
      if (gpuLayersChanged || threadsChanged || contextSizeChanged) {
        console.log("[TextChat] Settings changed, reloading model...", {
          gpuLayers: { from: prevGpuLayersRef.current, to: currentGpuLayers },
          threads: { from: prevThreadsRef.current, to: currentThreads },
          contextSize: { from: prevContextSizeRef.current, to: currentContextSize }
        });
        
        // Reload the model with new settings
        handleModelChange(selectedModel);
      }
    }
    
    // Update refs
    prevGpuLayersRef.current = currentGpuLayers;
    prevThreadsRef.current = currentThreads;
    prevContextSizeRef.current = currentContextSize;
  }, [textSettings?.gpuLayers, textSettings?.threads, textSettings?.contextSize]);

  const buildTextStartOptions = (settings) => ({
    threads: settings?.threads || specs?.cpu_cores_physical || 4,
    contextSize: settings?.contextSize ?? 0,
    gpuLayers: settings?.gpuLayers ?? -1,
    enableThinking: settings?.enableThinking === true,
    flashAttn: settings?.flashAttn,
    cacheTypeK: settings?.cacheTypeK,
    cacheTypeV: settings?.cacheTypeV,
    mlock: settings?.mlock,
    mmap: settings?.mmap,
    cachePrompt: settings?.cachePrompt,
    defragThold: settings?.defragThold,
    batchSize: settings?.batchSize,
    ubatchSize: settings?.ubatchSize,
    performanceProfile: settings?.performanceProfile,
  });

  const handleThinkingToggle = async () => {
    const enabled = !deepThinkEnabled;
    const nextSettings = { ...textSettings, enableThinking: enabled };

    if (!status.ready || !status.settings?.model) {
      setTextSettings(nextSettings);
      return;
    }

    const reload = await showConfirm({
      title: enabled ? "Reload With DeepThink?" : "Reload Without DeepThink?",
      message: "Changing DeepThink requires reloading the text model before it affects new replies. Reload now, or skip and keep the currently loaded model as-is?",
      confirmLabel: "Reload",
      cancelLabel: "Skip",
    });
    if (!reload) return;

    setIsBusy(true);
    try {
      setTextSettings(nextSettings);
      await stopLlm();
      const result = await startLlm(status.settings.model, buildTextStartOptions(nextSettings));
      setStatus({ ...status, ...result, ready: true, running: true, settings: result.settings });
    } catch (err) {
      showAlert({ title: "Text Model Reload Failed", message: err.message || String(err), danger: true });
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!supportsVision) {
      setAttachments((current) => current.filter((attachment) => attachment.type !== "image"));
    }
  }, [supportsVision]);

  // Load conversation messages when activeConversationId changes
  useEffect(() => {
    if (isBusy) return;
    if (activeConversationId) {
      const conv = conversations.find(c => c.id === activeConversationId);
      if (conv) {
        setMessages(conv.messages);
        if (conv.model && models.some(m => m.filename === conv.model)) {
          setSelectedModel(conv.model);
        }
        const total = conv.messages.reduce((sum, m) => {
          const text = Array.isArray(m.content)
            ? m.content.map(c => c.text || "").join(" ")
            : (m.content || "");
          return sum + estimateTokens(text) + estimateTokens(m.reasoning || "");
        }, 0);
        setTokenUsage({
          prompt_tokens: Math.round(total * 0.7),
          completion_tokens: Math.round(total * 0.3),
          total_tokens: total
        });
      }
    } else {
      setMessages([]);
      setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    }
  }, [activeConversationId, conversations, models, isBusy]);

  const refresh = useCallback(async () => {
    const [nextModels, nextStatus] = await Promise.all([listLlmModels(), getLlmStatus()]);
    const selectableModels = nextModels.filter((model) => !model.isProjector);
    setModels(selectableModels);
    setStatus(nextStatus);
    const active = nextStatus.settings?.model;
    setSelectedModel((current) => {
      const saved = localStorage.getItem("selectedLlmModel");
      const savedExists = selectableModels.some((m) => m.filename === saved);
      return active || current || (savedExists ? saved : "") || selectableModels[0]?.filename || "";
    });
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    const timer = setInterval(() => {
      getLlmStatus().then((nextStatus) => {
        setStatus(nextStatus);
        // If it suddenly loaded or became ready externally, update selection and reset loading states
        if (nextStatus.ready && nextStatus.settings?.model) {
          setSelectedModel(nextStatus.settings.model);
          setLoadingModel(null);
        }
      }).catch(() => {});
      getDownloadProgress().then((state) => {
        if (state.kind === "text" && (state.active || state.error || state.progress === 100)) {
          const completionKey = `${state.filename || ""}:${state.downloadedBytes || 0}`;
          if (!state.active && !state.error && completedDownloadRef.current !== completionKey) {
            completedDownloadRef.current = completionKey;
            refresh().catch(() => {});
          }
        }
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  useEffect(() => {
    const container = chatMessagesRef.current;
    if (!container) return;

    const len = messages.length;
    const prevLen = prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = len;

    const lastMessage = messages[len - 1];
    const isNewUserMessage = len > prevLen && lastMessage?.role === "user";

    if (isNewUserMessage || followGenerationRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } else {
      const threshold = 150;
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [messages, isBusy, loadingModel]);

  const handleModelChange = async (filename) => {
    if (!filename) {
      if (status.ready) {
        setIsBusy(true);
        try {
          await stopLlm();
          setStatus((prev) => ({ ...prev, ready: false, running: false }));
          setSelectedModel("");
          setMessages([]);
          setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        } catch (err) {
          showAlert({ title: "Unload Failed", message: err.message || String(err), danger: true });
        } finally {
          setIsBusy(false);
        }
      }
      return;
    }

    setSelectedModel(filename);
    localStorage.setItem("selectedLlmModel", filename);
    setIsBusy(true);
    setLoadingModel(filename);
    try {
      // Unload active image engine if running
      if (setActiveModel) setActiveModel(null);
      if (setServerRunning) setServerRunning(false);

      const result = await startLlm(filename, {
        threads: textSettings?.threads || specs?.cpu_cores_physical || 4,
        contextSize: textSettings?.contextSize ?? 0,
        gpuLayers: textSettings?.gpuLayers ?? -1,
        enableThinking: textSettings?.enableThinking === true,
        flashAttn: textSettings?.flashAttn,
        cacheTypeK: textSettings?.cacheTypeK,
        cacheTypeV: textSettings?.cacheTypeV,
        mlock: textSettings?.mlock,
        mmap: textSettings?.mmap,
        cachePrompt: textSettings?.cachePrompt,
        defragThold: textSettings?.defragThold,
        batchSize: textSettings?.batchSize,
        ubatchSize: textSettings?.ubatchSize,
        performanceProfile: textSettings?.performanceProfile,
      });
      setStatus({ ...status, ...result, ready: true, running: true, settings: result.settings });
      setMessages([]);
      setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    } catch (err) {
      if (loadingModelRef.current === filename) {
        showAlert({ title: "Text Model Load Failed", message: err.message, danger: true });
      }
    } finally {
      setLoadingModel(null);
      setIsBusy(false);
    }
  };

  const handleCancelLlmLoad = async () => {
    try {
      await stopLlm();
    } catch (_) {}
    setLoadingModel(null);
    setIsBusy(false);
    setSelectedModel("");
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
  };

  const sendMessage = async () => {
    const text = input.trim();
    const hasAttachments = attachments.length > 0;
    if ((!text && !hasAttachments) || isBusy || !status.ready) return;

    let convId = activeConversationId;
    let isNew = false;
    if (!convId) {
      convId = "chat_" + Date.now();
      setActiveConversationId(convId);
      isNew = true;
    }

    // Delimited context blocks for document attachments
    let documentContext = "";
    attachments.filter(att => att.type === "document").forEach((att) => {
      documentContext += `\n[Attached File: ${att.name}]\n${att.content}\n`;
    });

    const imageAttachments = attachments.filter(att => att.type === "image");
    const conversationHasImage = messages.some(messageContainsImage);
    const requestHasImage = imageAttachments.length > 0 || conversationHasImage;
    const visionInstruction = requestHasImage
      ? "For images in this conversation: answer in natural language, describe the actual image content, and read visible text carefully when relevant. If the user asks a follow-up like \"what is this\" or \"explain\", treat it as referring to the most recent image unless they say otherwise. Do not output raw JSON, arrays, bounding boxes, OCR layout objects, UI class names, or detection labels unless the user explicitly asks for that format."
      : "";
    const requestText = imageAttachments.length > 0
      ? (text && text !== "?" ? text : "Describe what is visible in the image.")
      : text;
    const displayText = text || (imageAttachments.length > 0 ? "Describe what is visible in the image." : "");
    const requestCombinedText = [
      requestText,
      documentContext,
    ].filter(Boolean).join("\n\n").trim();
    const displayCombinedText = documentContext
      ? [displayText, documentContext].filter(Boolean).join("\n\n").trim()
      : displayText;

    let userMessageContent;
    let requestUserMessageContent;
    if (imageAttachments.length > 0) {
      userMessageContent = [
        {
          type: "text",
          text: displayCombinedText
        },
        ...imageAttachments.map((img) => ({
          type: "image_url",
          image_url: {
            url: img.dataUrl
          }
        }))
      ];
      requestUserMessageContent = [
        {
          type: "text",
          text: requestCombinedText
        },
        ...imageAttachments.map((img) => ({
          type: "image_url",
          image_url: {
            url: img.sendDataUrl || img.dataUrl
          }
        }))
      ];
    } else {
      userMessageContent = displayCombinedText;
      requestUserMessageContent = requestCombinedText;
    }

    const nextMessages = [...messages, { role: "user", content: userMessageContent }];
    const requestConversationMessages = [...messages, { role: "user", content: requestUserMessageContent }];
    followGenerationRef.current = true;
    setMessages(nextMessages);
    setInput("");
    setIsBusy(true);

    const displayTitleText = text || (imageAttachments.length > 0 ? "Sent Image" : "Sent File");
    const firstTitle = isNew ? (displayTitleText.slice(0, 26) + (displayTitleText.length > 26 ? "..." : "")) : null;
    saveConversationState(convId, nextMessages, selectedModel, firstTitle);

    const requestStartedAt = performance.now();
    setMessages([...nextMessages, {
      role: "assistant",
      content: "",
      generationStats: { status: "starting", tokens: 0, tokensPerSecond: 0, seconds: 0, vision: requestHasImage, web: useWebSearch },
    }]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const systemPrompt = textSettings?.systemPrompt || "You are a helpful local AI assistant.";
      const combinedSystemPrompt = [
        systemPrompt.trim(),
        visionInstruction,
      ].filter(Boolean).join("\n\n");
      const requestMessages = [
        ...(combinedSystemPrompt ? [{ role: "system", content: combinedSystemPrompt }] : []),
        ...requestConversationMessages,
      ];
      const promptTokenEstimate = requestMessages.reduce((sum, message) => {
        const messageText = Array.isArray(message.content)
          ? message.content.map((item) => item.text || "").join(" ")
          : (message.content || "");
        return sum + estimateTokens(messageText);
      }, 0);
      setTokenUsage({
        prompt_tokens: promptTokenEstimate,
        completion_tokens: 0,
        total_tokens: promptTokenEstimate,
      });

      let assistantText = "";
      let rawAssistantText = "";
      let assistantReasoning = "";
      let streamedTokens = 0;
      let firstTokenAt = null;
      let thinkingStartedAt = null;
      let thinkingEndedAt = null;
      let thinkingDuration = 0;

      const thinkingEnabled = deepThinkEnabled;
      const manualMaxTokens = textSettings?.maxTokens || 1024;
      const effectiveMaxTokens = textSettings?.responseTokenMode === "manual"
        ? (thinkingEnabled ? Math.max(manualMaxTokens, 1024) : manualMaxTokens)
        : getAutoMaxResponseTokens(promptTokenEstimate, thinkingEnabled);

      const response = await streamChatWithLlm(requestMessages, {
        temperature: textSettings?.temperature || 0.7,
        maxTokens: effectiveMaxTokens,
        topP: textSettings?.topP,
        topK: textSettings?.topK,
        minP: textSettings?.minP,
        repeatPenalty: textSettings?.repeatPenalty,
        seed: textSettings?.seed,
        enableThinking: thinkingEnabled,
        useWeb: useWebSearch,
        timeFilter: webTimeFilter,
        signal: controller.signal,
      }, (_token, fullText, _reasoningToken, fullReasoning) => {
        const now = performance.now();
        if (streamedTokens === 0) {
          firstTokenAt = now;
        }
        streamedTokens += 1;
        const generationSeconds = firstTokenAt
          ? Math.max(0.05, (now - firstTokenAt) / 1000)
          : Math.max(0.05, (now - requestStartedAt) / 1000);
        
        rawAssistantText = fullText;
        const processed = processMessageContent(fullText, fullReasoning, deepThinkEnabled);
        assistantText = processed.content;
        assistantReasoning = processed.reasoning;

        // Calculate thinking duration
        if (processed.reasoning && !thinkingStartedAt) {
          thinkingStartedAt = now;
        }
        if (processed.content && thinkingStartedAt && !thinkingEndedAt) {
          thinkingEndedAt = now;
          thinkingDuration = (thinkingEndedAt - thinkingStartedAt) / 1000;
        }
        const currentThinkingDuration = thinkingEndedAt 
          ? thinkingDuration 
          : (thinkingStartedAt ? (now - thinkingStartedAt) / 1000 : 0);

        // Debounced stats update: only update stats every 250ms for smoother UI
        // while text still updates per-frame via rAF batching
        const currentStats = {
          status: "streaming",
          tokens: streamedTokens,
          tokensPerSecond: streamedTokens / generationSeconds,
          seconds: (now - requestStartedAt) / 1000,
        };
        // rAF batching: accumulate updates and flush once per frame (~16ms)
        // This reduces React re-renders from N per token to ~60/sec
        tokenBufferRef.current = {
          content: processed.content,
          reasoning: processed.reasoning,
          thinkingDuration: currentThinkingDuration,
          stats: currentStats,
        };

        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            const buffer = tokenBufferRef.current;
            if (buffer) {
              setMessages((prev) => {
                const updated = [...prev];
                if (updated.length > 0 && updated[updated.length - 1].role === "assistant") {
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    content: buffer.content,
                    reasoning: buffer.reasoning,
                    thinkingDuration: buffer.thinkingDuration,
                    generationStats: buffer.stats,
                  };
                }
                return updated;
              });
              tokenBufferRef.current = null;
            }
            rafRef.current = null;
          });
        }
      });

      const completedAt = performance.now();
      let finalThinkingDuration = thinkingDuration;
      if (thinkingStartedAt && !thinkingEndedAt) {
        thinkingEndedAt = completedAt;
        finalThinkingDuration = (thinkingEndedAt - thinkingStartedAt) / 1000;
      }

      const exactTokens = Number(response.timings?.predicted_n) || streamedTokens;
      const backendTotalMs = Number(response.timings?.prompt_ms || 0) + Number(response.timings?.predicted_ms || 0);
      const exactSeconds = backendTotalMs > 0
        ? backendTotalMs / 1000
        : (completedAt - requestStartedAt) / 1000;
      const exactTokensPerSecond = Number(response.timings?.predicted_per_second)
        || (exactTokens / Math.max(0.001, exactSeconds));
      const generationStats = {
        status: "complete",
        tokens: exactTokens,
        tokensPerSecond: exactTokensPerSecond,
        seconds: exactSeconds,
        finishReason: response.finishReason || null,
        truncated: response.finishReason === "length",
      };
      
      const processed = processMessageContent(response.content || rawAssistantText || assistantText, response.reasoningContent || assistantReasoning, deepThinkEnabled);
      const finalMessages = [...nextMessages, {
        role: "assistant",
        content: processed.content,
        reasoning: processed.reasoning,
        thinkingDuration: finalThinkingDuration,
        generationStats,
        webSources: response.webSources || [],
      }];
      setMessages(finalMessages);
      saveConversationState(convId, finalMessages, selectedModel);
      const finalCompletionEstimate = Math.max(
        exactTokens,
        estimateTokens(processed.content) + estimateTokens(processed.reasoning)
      );
      const finalUsageEstimate = {
        prompt_tokens: promptTokenEstimate,
        completion_tokens: finalCompletionEstimate,
        total_tokens: promptTokenEstimate + finalCompletionEstimate,
      };
      setTokenUsage(response.usage
        ? {
            prompt_tokens: Math.max(Number(response.usage.prompt_tokens) || 0, finalUsageEstimate.prompt_tokens),
            completion_tokens: Math.max(Number(response.usage.completion_tokens) || 0, finalUsageEstimate.completion_tokens),
            total_tokens: Math.max(Number(response.usage.total_tokens) || 0, finalUsageEstimate.total_tokens),
          }
        : finalUsageEstimate
      );
      
      // Clean up attached files on success
      setAttachments([]);
    } catch (err) {
      if (err.name === "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          if (updated.length > 0 && updated[updated.length - 1].role === "assistant") {
            const lastMsg = updated[updated.length - 1];
            updated[updated.length - 1] = {
              ...lastMsg,
              generationStats: lastMsg.generationStats ? {
                ...lastMsg.generationStats,
                status: "complete",
              } : null
            };
            saveConversationState(convId, updated, selectedModel);
          }
          return updated;
        });
      } else {
        const finalMessages = [...nextMessages, { role: "assistant", content: `Error: ${err.message}`, error: true }];
        setMessages(finalMessages);
        saveConversationState(convId, finalMessages, selectedModel);
      }
    } finally {
      setIsBusy(false);
      abortControllerRef.current = null;
      setTimeout(() => {
        followGenerationRef.current = false;
      }, 250);
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setTokenUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    if (activeConversationId) {
      saveConversationState(activeConversationId, [], selectedModel);
    }
  };

  return (
    <div className="text-chat-layout" style={{ display: "flex", height: "100%", width: "100%", boxSizing: "border-box", overflow: "hidden" }}>
      <section className="text-chat-main" style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        {/* ─── Header ─────────────────────────────────────────── */}
        <div className="text-chat-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: 1 }}>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="m3-btn m3-btn-tonal"
              style={{
                height: "34px", width: "34px", padding: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "var(--md-shape-corner-medium)", cursor: "pointer",
                background: showHistory ? "var(--md-sys-color-primary-container)" : "var(--md-sys-color-surface-variant)",
                color: showHistory ? "var(--md-sys-color-on-primary-container)" : "var(--md-sys-color-on-surface)",
                border: "1px solid var(--border-color)", flexShrink: 0
              }}
              title="Toggle Chat History"
            >
              <History size={17} />
            </button>

            <button
              onClick={handleNewChat}
              className="m3-btn m3-btn-tonal"
              style={{
                height: "34px", width: "34px", padding: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "var(--md-shape-corner-medium)", cursor: "pointer",
                background: "var(--md-sys-color-surface-variant)",
                color: "var(--md-sys-color-on-surface)",
                border: "1px solid var(--border-color)", flexShrink: 0
              }}
              title="Start New Chat"
              disabled={isBusy}
            >
              <Plus size={17} />
            </button>

            <div ref={modelMenuRef} style={{ position: "relative", display: "inline-block", flex: "0 1 280px", maxWidth: "280px", width: "100%" }}>
              <button
                onClick={() => !isBusy && setShowModelMenu(!showModelMenu)}
                className={`chat-model-select-trigger ${showModelMenu ? "active" : ""}`}
                disabled={isBusy}
                title="Select GGUF Model"
              >
                <span className="chat-model-select-label">
                  {selectedModel ? selectedModel : "No model loaded (Select GGUF)"}
                </span>
                <ChevronDown size={14} className={`chat-model-select-arrow ${showModelMenu ? "open" : ""}`} />
              </button>

              {showModelMenu && (
                <div className="chat-model-dropdown-menu">
                  <button
                    className={`chat-model-dropdown-item ${!selectedModel ? "selected" : ""}`}
                    onClick={() => {
                      handleModelChange("");
                      setShowModelMenu(false);
                    }}
                  >
                    No model loaded (Select GGUF)
                  </button>
                  {models.map((m) => {
                    const isActive = m.filename === status.settings?.model && status.ready;
                    const isSelected = m.filename === selectedModel;
                    return (
                      <button
                        key={m.filename}
                        className={`chat-model-dropdown-item ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`}
                        onClick={() => {
                          handleModelChange(m.filename);
                          setShowModelMenu(false);
                        }}
                        title={m.filename}
                      >
                        <span className="chat-model-name-text">{m.filename}</span>
                        {isActive && <span className="chat-model-active-badge">Active</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {isBusy && !loadingModel && <LoaderCircle className="progress-spinner" size={16} />}
            {selectedModel && (!status.ready || status.settings?.model !== selectedModel) && !loadingModel && (
              <button
                className="m3-btn m3-btn-filled"
                onClick={() => handleModelChange(selectedModel)}
                disabled={isBusy}
                style={{
                  height: "38px", padding: "0 16px", fontSize: "0.85rem",
                  borderRadius: "var(--md-shape-corner-medium)",
                  background: "var(--md-sys-color-primary)",
                  color: "var(--md-sys-color-on-primary)",
                  cursor: "pointer", border: "none", fontWeight: "600",
                  display: "flex", alignItems: "center", gap: "6px"
                }}
              >
                Load Model
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
            {/* Context gauge */}
            {(() => {
              const maxTokens = status.settings?.contextSize || 4096;
              const used = tokenUsage.total_tokens || 0;
              const percent = Math.min(100, Math.round((used / maxTokens) * 100));
              return (
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }} title={`Context Used: ${used} / ${maxTokens} tokens`}>
                  <div style={{ position: "relative", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="32" height="32" viewBox="0 0 40 40">
                      <circle cx="20" cy="20" r="16" stroke="var(--border-color)" strokeWidth="3" fill="transparent" />
                      <circle cx="20" cy="20" r="16" stroke="var(--md-sys-color-primary)" strokeWidth="3" fill="transparent"
                        strokeDasharray={2 * Math.PI * 16}
                        strokeDashoffset={2 * Math.PI * 16 * (1 - percent / 100)}
                        strokeLinecap="round" transform="rotate(-90 20 20)"
                        style={{ transition: "stroke-dashoffset 0.35s" }}
                      />
                    </svg>
                    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: "0.58rem", fontWeight: "700", lineHeight: 1 }}>{percent}%</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                    <span style={{ fontSize: "0.6rem", color: "var(--md-sys-color-outline)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>Context</span>
                    <span style={{ fontSize: "0.76rem", fontWeight: "600", color: "var(--md-sys-color-on-surface)" }}>{used} / {maxTokens}</span>
                  </div>
                </div>
              );
            })()}

            <button
              className="m3-btn m3-btn-outlined"
              style={{ height: "32px", padding: "0 10px", display: "flex", alignItems: "center", gap: "6px", fontSize: "0.78rem", borderRadius: "var(--md-shape-corner-medium)" }}
              onClick={handleClearChat}
              disabled={messages.length === 0}
            >
              <Trash2 size={14} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* ─── Messages area ──────────────────────────────────── */}
        <div
          ref={chatMessagesRef}
          className="chat-messages"
          onWheel={() => {
            if (isBusy) followGenerationRef.current = false;
          }}
          onTouchMove={() => {
            if (isBusy) followGenerationRef.current = false;
          }}
        >
          {loadingModel ? (
            <div className="chat-empty" style={{ maxWidth: "480px", margin: "auto", textAlign: "center", padding: "60px 20px" }}>
              <LoaderCircle className="progress-spinner" size={48} style={{ color: "var(--md-sys-color-primary)", marginBottom: "16px" }} />
              <h3 style={{ fontWeight: 600, fontSize: "1.25rem", marginBottom: "8px", color: "var(--md-sys-color-on-surface)" }}>Loading Text Model</h3>
              <code style={{
                display: "block", background: "var(--md-sys-color-surface-variant)",
                color: "var(--md-sys-color-on-surface-variant)", padding: "8px 12px",
                borderRadius: "6px", fontSize: "0.85rem", marginBottom: "20px",
                wordBreak: "break-all", fontFamily: "monospace"
              }}>
                {loadingModel}
              </code>
              <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-outline)", lineHeight: 1.5, marginBottom: "24px" }}>
                Initializing llama.cpp server and loading the model weights into memory. This can take up to 30 seconds depending on model size and hardware speed.
              </p>
              <button className="m3-btn m3-btn-error" onClick={handleCancelLlmLoad}
                style={{ display: "inline-flex", alignItems: "center", gap: "8px", height: "38px", padding: "0 16px", fontSize: "0.85rem", borderRadius: "var(--md-shape-corner-medium)" }}
              >
                <Square size={14} fill="currentColor" />
                <span>Cancel Load</span>
              </button>
            </div>
          ) : (
            <>
              {messages.length === 0 && (
                <div className="chat-empty">
                  <div className="chat-empty-icon">
                    <Bot size={30} />
                  </div>
                  <h3>Local AI Chat</h3>
                  <p>Your private, offline AI assistant. Choose a GGUF model above and start a conversation — everything stays on your machine.</p>
                  {status.ready && (
                    <div className="chat-suggestions">
                      {[
                        { icon: "✍️", text: "Write a professional email to reschedule a meeting" },
                        { icon: "💡", text: "Explain how transformers work in simple terms" },
                        { icon: "🐛", text: "Help me debug this Python code" },
                        { icon: "📋", text: "Summarize the key points of a topic" },
                      ].map((s, i) => (
                        <button
                          key={i}
                          className="chat-suggestion-chip"
                          onClick={() => { setInput(s.text); }}
                        >
                          <span style={{ fontSize: "1rem", flexShrink: 0 }}>{s.icon}</span>
                          <span>{s.text}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {messages.map((message, index) => {
                const processed = processMessageContent(
                  Array.isArray(message.content) ? "" : (message.content || ""),
                  message.reasoning || "",
                  deepThinkEnabled
                );
                const displayContent = Array.isArray(message.content) ? message.content : processed.content;
                const displayReasoning = processed.reasoning;
                const hasDisplayContent = Array.isArray(displayContent)
                  ? displayContent.length > 0
                  : Boolean(String(displayContent || "").trim());

                return (
                  <div
                    key={`${message.role}-${index}`}
                    className={`chat-message-row ${message.role === "user" ? "user" : "ai"}`}
                  >
                    {/* Avatar */}
                    <div className={`chat-avatar ${message.role === "user" ? "user" : "ai"}`}>
                      {message.role === "user" ? "You" : "AI"}
                    </div>

                    {/* Bubble + stats */}
                    <div className="chat-bubble-wrap">
                      <span className="chat-sender-label">
                        {message.role === "user" ? "You" : "Local AI"}
                      </span>
                      {message.role === "assistant" && displayReasoning && deepThinkEnabled && (
                        <ThinkingBlock
                          reasoning={displayReasoning}
                          thinkingDuration={message.thinkingDuration}
                          isComplete={!message.generationStats || message.generationStats.status === "complete"}
                        />
                      )}
                      {(hasDisplayContent || message.error) && (
                        <div className={`chat-bubble ${message.error ? "error" : ""}`}>
                          {Array.isArray(displayContent) ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                              {displayContent.map((item, idx) => {
                                if (item.type === "text") return <MarkdownRenderer key={idx} content={item.text} />;
                                if (item.type === "image_url") return (
                                  <img key={idx} src={item.image_url.url} alt="Attached image"
                                    style={{ maxWidth: "240px", maxHeight: "180px", objectFit: "contain", borderRadius: "8px", marginTop: "4px" }}
                                  />
                                );
                                return null;
                              })}
                            </div>
                          ) : (
                            <MarkdownRenderer content={displayContent} />
                          )}
                        </div>
                      )}
                      {message.role === "assistant" && Array.isArray(message.webSources) && message.webSources.length > 0 && (
                        <div style={{
                          marginTop: "8px",
                          padding: "10px 12px",
                          border: "1px solid var(--border-color)",
                          borderRadius: "8px",
                          background: "var(--md-sys-color-surface-container)",
                          fontSize: "0.8rem",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, marginBottom: "6px" }}>
                            <Globe2 size={13} />
                            <span>Sources</span>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                            {message.webSources.map((source, sourceIndex) => (
                              <a
                                key={`${source.url}-${sourceIndex}`}
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--md-sys-color-primary)", textDecoration: "none", overflowWrap: "anywhere" }}
                              >
                                [{source.index || sourceIndex + 1}] {source.title || source.url}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Generation stats pill */}
                      {message.role === "assistant" && message.generationStats && !message.error && (
                        <>
                          {message.generationStats.truncated && (
                            <div className="chat-generation-warning">
                              Response reached the token limit. Ask "continue" or switch Max Response Tokens to Manual for a larger cap.
                            </div>
                          )}
                          <div className={`chat-generation-stats ${message.generationStats.status}`}>
                          {message.generationStats.status === "starting" ? (
                            <><LoaderCircle size={11} className="progress-spinner" /> {message.generationStats.web ? "Searching web..." : message.generationStats.vision ? "Processing image..." : "Waiting for first token..."}</>
                          ) : message.generationStats.status === "streaming" ? (
                            <><span style={{ opacity: 0.7 }}>⚡</span> {message.generationStats.tokensPerSecond.toFixed(1)} tok/s</>
                          ) : (
                            <>{message.generationStats.tokens} tokens <span style={{ opacity: 0.5 }}>•</span> {formatGenerationTime(message.generationStats.seconds)}</>
                          )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        {/* ─── Composer ───────────────────────────────────────── */}
        <div className="chat-composer">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingBottom: "10px" }}>
              {attachments.map((att) => (
                <div key={att.id} style={{
                  position: "relative", display: "flex", alignItems: "center", gap: "6px",
                  padding: "6px 28px 6px 8px",
                  background: "var(--md-sys-color-surface-variant)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px", fontSize: "0.8rem", maxWidth: "200px"
                }}>
                  {att.type === "image" ? (
                    <img src={att.dataUrl} alt={att.name} style={{ width: "24px", height: "24px", objectFit: "cover", borderRadius: "3px" }} />
                  ) : (
                    <span style={{ fontWeight: 600 }}>📄</span>
                  )}
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--md-sys-color-on-surface-variant)" }} title={att.name}>
                    {att.name}
                  </span>
                  <button
                    onClick={() => setAttachments(prev => prev.filter(item => item.id !== att.id))}
                    style={{
                      position: "absolute", right: "4px", top: "50%", transform: "translateY(-50%)",
                      background: "none", border: "none", color: "var(--md-sys-color-error)",
                      cursor: "pointer", padding: "2px", display: "flex", alignItems: "center", justifyContent: "center"
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input container with vertical layout */}
          <div className="chat-composer-inner">
            <div className="chat-composer-textarea-container">
              <textarea
                ref={textareaRef}
                className="chat-composer-textarea"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={status.ready ? "Message your local model... (Shift+Enter for new line)" : "Select and load a GGUF model above to begin"}
                disabled={!status.ready || isBusy}
                rows={1}
              />
            </div>

            <div className="chat-composer-toolbar">
              <div className="chat-composer-toolbar-left">
                <input type="file" ref={fileInputRef} style={{ display: "none" }} multiple onChange={handleFileChange} />
                <button
                  className="chat-composer-attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!supportsVision || isBusy}
                  title={supportsVision ? "Attach files or images" : visionStatus}
                >
                  <Paperclip size={17} />
                </button>
                <button
                  className={`chat-composer-deepthink-btn web-search-btn ${useWebSearch ? "active" : ""}`}
                  onClick={() => setUseWebSearch((value) => !value)}
                  disabled={!status.ready || isBusy}
                  title={useWebSearch ? "Disable web search" : "Enable web search"}
                >
                  <Globe2 size={14} />
                  <span>Web</span>
                </button>

                {status.ready && supportsThinking && (
                  <button
                    className={`chat-composer-deepthink-btn deepthink-btn ${deepThinkEnabled ? "active" : ""}`}
                    onClick={handleThinkingToggle}
                    title={deepThinkEnabled ? "Disable DeepThink reasoning" : "Enable DeepThink reasoning"}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={deepThinkEnabled ? "rotate-anim" : ""}>
                      <circle cx="12" cy="12" r="3" />
                      <ellipse cx="12" cy="12" rx="3" ry="9" />
                      <ellipse cx="12" cy="12" rx="9" ry="3" />
                    </svg>
                    <span>DeepThink</span>
                  </button>
                )}
              </div>

              <div className="chat-composer-toolbar-right">
                {isBusy && status.ready ? (
                  <button className="chat-composer-stop-btn" onClick={handleStopGeneration} title="Stop generation">
                    <Square size={15} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="chat-composer-send-btn"
                    onClick={sendMessage}
                    disabled={(!input.trim() && attachments.length === 0) || !status.ready}
                    title="Send message"
                  >
                    <Send size={17} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="chat-composer-hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</div>
        </div>
      </section>
    </div>
  );
}
function parseInlineMarkdown(text) {
  const regex = /(\*\*.*?\*\*|`.*?`|\*.*?\*|\[.*?\]\(.*?\))/g;
  const parts = text.split(regex);

  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx} style={{ fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={idx} style={{ 
        fontFamily: "monospace", 
        background: "var(--md-sys-color-surface-variant)", 
        padding: "2px 4px", 
        borderRadius: "4px",
        fontSize: "0.85rem"
      }}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={idx} style={{ fontStyle: "italic" }}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
      const match = part.match(/\[(.*?)\]\((.*?)\)/);
      if (match) {
        return (
          <a key={idx} href={match[2]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--md-sys-color-primary)", textDecoration: "underline" }}>
            {match[1]}
          </a>
        );
      }
    }
    return part;
  });
}

export function MarkdownRenderer({ content }) {
  if (typeof content !== 'string') return null;

  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="markdown-body" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {parts.map((part, index) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const match = part.match(/```(\w*)\n([\s\S]*?)```/);
          const lang = match ? match[1] : "";
          const code = match ? match[2] : part.slice(3, -3);
          return (
            <pre key={index} style={{ 
              background: "var(--md-sys-color-surface-variant)", 
              color: "var(--md-sys-color-on-surface-variant)",
              padding: "12px", 
              borderRadius: "6px", 
              fontFamily: "monospace", 
              fontSize: "0.85rem",
              overflowX: "auto",
              margin: "6px 0",
              border: "1px solid var(--border-color)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            }}>
              {lang && <div style={{ fontSize: "0.72rem", color: "var(--md-sys-color-outline)", marginBottom: "4px", textTransform: "uppercase", fontWeight: 600 }}>{lang}</div>}
              <code>{code.trim()}</code>
            </pre>
          );
        } else {
          const rawLines = part.split(/\r?\n/);
          const blocks = [];
          let currentBlock = null;

          for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith("### ")) {
              if (currentBlock) { blocks.push(currentBlock); currentBlock = null; }
              blocks.push({ type: "h4", content: trimmed.slice(4) });
            } else if (trimmed.startsWith("## ")) {
              if (currentBlock) { blocks.push(currentBlock); currentBlock = null; }
              blocks.push({ type: "h3", content: trimmed.slice(3) });
            } else if (trimmed.startsWith("# ")) {
              if (currentBlock) { blocks.push(currentBlock); currentBlock = null; }
              blocks.push({ type: "h2", content: trimmed.slice(2) });
            } else if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
              const itemContent = trimmed.slice(2);
              if (currentBlock && currentBlock.type === "ul") {
                currentBlock.items.push(itemContent);
              } else {
                if (currentBlock) { blocks.push(currentBlock); }
                currentBlock = { type: "ul", items: [itemContent] };
              }
            } else {
              const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
              if (numMatch) {
                const itemContent = numMatch[2];
                if (currentBlock && currentBlock.type === "ol") {
                  currentBlock.items.push(itemContent);
                } else {
                  if (currentBlock) { blocks.push(currentBlock); }
                  currentBlock = { type: "ol", items: [itemContent] };
                }
              } else if (trimmed === "") {
                if (currentBlock) { blocks.push(currentBlock); currentBlock = null; }
                blocks.push({ type: "spacer" });
              } else {
                if (currentBlock && currentBlock.type === "p") {
                  currentBlock.lines.push(line);
                } else {
                  if (currentBlock) { blocks.push(currentBlock); }
                  currentBlock = { type: "p", lines: [line] };
                }
              }
            }
          }
          if (currentBlock) {
            blocks.push(currentBlock);
          }

          return blocks.map((block, blockIdx) => {
            switch (block.type) {
              case "h4":
                return <h4 key={blockIdx} style={{ fontSize: "1.05rem", fontWeight: 700, margin: "10px 0 4px 0", color: "var(--md-sys-color-primary)" }}>{parseInlineMarkdown(block.content)}</h4>;
              case "h3":
                return <h3 key={blockIdx} style={{ fontSize: "1.2rem", fontWeight: 700, margin: "14px 0 6px 0", color: "var(--md-sys-color-primary)" }}>{parseInlineMarkdown(block.content)}</h3>;
              case "h2":
                return <h2 key={blockIdx} style={{ fontSize: "1.35rem", fontWeight: 700, margin: "18px 0 8px 0", color: "var(--md-sys-color-primary)" }}>{parseInlineMarkdown(block.content)}</h2>;
              case "ul":
                return (
                  <ul key={blockIdx} style={{ margin: "6px 0 6px 24px", padding: 0, listStyleType: "disc", display: "block" }}>
                    {block.items.map((item, itemIdx) => (
                      <li key={itemIdx} style={{ fontSize: "0.9rem", lineHeight: 1.5, marginBottom: "4px", display: "list-item" }}>{parseInlineMarkdown(item)}</li>
                    ))}
                  </ul>
                );
              case "ol":
                return (
                  <ol key={blockIdx} style={{ margin: "6px 0 6px 24px", padding: 0, listStyleType: "decimal", display: "block" }}>
                    {block.items.map((item, itemIdx) => (
                      <li key={itemIdx} style={{ fontSize: "0.9rem", lineHeight: 1.5, marginBottom: "4px", display: "list-item" }}>{parseInlineMarkdown(item)}</li>
                    ))}
                  </ol>
                );
              case "spacer":
                return <div key={blockIdx} style={{ height: "6px" }} />;
              case "p":
                return <p key={blockIdx} style={{ margin: "2px 0", fontSize: "0.9rem", lineHeight: 1.5 }}>{parseInlineMarkdown(block.lines.join(" "))}</p>;
              default:
                return null;
            }
          });
        }
      })}
    </div>
  );
}

export default TextChat;
