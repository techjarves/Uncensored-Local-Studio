import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, Send, Trash2, Square, History, Paperclip, X } from "lucide-react";
import {
  getDownloadProgress,
  getLlmStatus,
  listLlmModels,
  streamChatWithLlm,
  startLlm,
  stopLlm,
} from "../services/api";

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
  saveConversationState
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
  const [loadingModel, setLoadingModel] = useState(null);
  const [tokenUsage, setTokenUsage] = useState({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  });
  
  const bottomRef = useRef(null);
  const completedDownloadRef = useRef("");
  const loadingModelRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const prevMessagesLengthRef = useRef(0);
  const abortControllerRef = useRef(null);

  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const supportsVision = Boolean(status.ready && status.settings?.supportsVision);

  const isImage = (file) => {
    return /\.(jpe?g|png|webp)$/i.test(file.name) || file.type.startsWith("image/");
  };

  const isTextFile = (file) => {
    return /\.(txt|md|csv|js|jsx|ts|tsx|py|json|css|html|java|cpp|c|h|rs|go|sh|bat|xml|yaml|yml)$/i.test(file.name) || file.type.startsWith("text/");
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    if (!files || files.length === 0) return;

    files.forEach((file) => {
      if (isImage(file)) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substring(7),
              file,
              type: "image",
              name: file.name,
              dataUrl: event.target.result,
            },
          ]);
        };
        reader.readAsDataURL(file);
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
          return sum + text.split(/\s+/).length;
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
    setModels(nextModels);
    setStatus(nextStatus);
    const active = nextStatus.settings?.model;
    setSelectedModel((current) => {
      const saved = localStorage.getItem("selectedLlmModel");
      const savedExists = nextModels.some((m) => m.filename === saved);
      return active || current || (savedExists ? saved : "") || nextModels[0]?.filename || "";
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

    if (isNewUserMessage) {
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
        contextSize: textSettings?.contextSize || 4096,
        gpuLayers: -1,
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

    const combinedText = documentContext ? `${text}\n\n${documentContext}`.trim() : text;
    const imageAttachments = attachments.filter(att => att.type === "image");

    let userMessageContent;
    if (imageAttachments.length > 0) {
      userMessageContent = [
        {
          type: "text",
          text: combinedText
        },
        ...imageAttachments.map((img) => ({
          type: "image_url",
          image_url: {
            url: img.dataUrl
          }
        }))
      ];
    } else {
      userMessageContent = combinedText;
    }

    const nextMessages = [...messages, { role: "user", content: userMessageContent }];
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
      generationStats: { status: "starting", tokens: 0, tokensPerSecond: 0, seconds: 0 },
    }]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const systemPrompt = textSettings?.systemPrompt || "You are a helpful local AI assistant.";
      const requestMessages = [
        ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
        ...nextMessages,
      ];

      let assistantText = "";
      let streamedTokens = 0;
      let firstTokenAt = null;

      const response = await streamChatWithLlm(requestMessages, {
        temperature: textSettings?.temperature || 0.7,
        maxTokens: 768,
        signal: controller.signal,
      }, (_token, fullText) => {
        const now = performance.now();
        if (streamedTokens === 0) {
          firstTokenAt = now;
        }
        streamedTokens += 1;
        const generationSeconds = firstTokenAt
          ? Math.max(0.05, (now - firstTokenAt) / 1000)
          : Math.max(0.05, (now - requestStartedAt) / 1000);
        assistantText = fullText;
        setMessages((prev) => {
          const updated = [...prev];
          if (updated.length > 0 && updated[updated.length - 1].role === "assistant") {
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: fullText,
              generationStats: {
                status: "streaming",
                tokens: streamedTokens,
                tokensPerSecond: streamedTokens / generationSeconds,
                seconds: (now - requestStartedAt) / 1000,
              },
            };
          }
          return updated;
        });
      });

      const completedAt = performance.now();
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
      };
      const finalMessages = [...nextMessages, {
        role: "assistant",
        content: assistantText,
        generationStats,
      }];
      setMessages(finalMessages);
      saveConversationState(convId, finalMessages, selectedModel);
      if (response.usage) setTokenUsage(response.usage);
      
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
    <div className="text-chat-layout" style={{ display: "flex", padding: "20px", height: "100%", width: "100%", boxSizing: "border-box", overflow: "hidden" }}>
      <section className="text-chat-main" style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        <div className="text-chat-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {/* Toggle History Sidebar button */}
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="m3-btn m3-btn-tonal"
              style={{
                height: "38px",
                width: "38px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--md-shape-corner-medium)",
                cursor: "pointer",
                background: showHistory ? "var(--md-sys-color-primary-container)" : "var(--md-sys-color-surface-variant)",
                color: showHistory ? "var(--md-sys-color-on-primary-container)" : "var(--md-sys-color-on-surface)",
                border: "1px solid var(--border-color)",
                flexShrink: 0
              }}
              title="Toggle Chat History"
            >
              <History size={18} />
            </button>

            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={isBusy}
              style={{
                fontSize: "0.95rem",
                fontWeight: "600",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--md-shape-corner-medium)",
                background: "var(--md-sys-color-surface-variant)",
                color: "var(--md-sys-color-on-surface)",
                padding: "8px 16px",
                outline: "none",
                cursor: "pointer",
                minWidth: "220px"
              }}
            >
              <option value="">No model loaded (Select GGUF)</option>
              {models.map((m) => (
                <option key={m.filename} value={m.filename}>
                  {m.filename} {m.filename === status.settings?.model && status.ready ? "• Active" : ""}
                </option>
              ))}
            </select>
            {isBusy && !loadingModel && <LoaderCircle className="progress-spinner" size={16} />}
            {selectedModel && (!status.ready || status.settings?.model !== selectedModel) && !loadingModel && (
              <button
                className="m3-btn m3-btn-filled"
                onClick={() => handleModelChange(selectedModel)}
                disabled={isBusy}
                style={{
                  height: "38px",
                  padding: "0 16px",
                  fontSize: "0.85rem",
                  borderRadius: "var(--md-shape-corner-medium)",
                  background: "var(--md-sys-color-primary)",
                  color: "var(--md-sys-color-on-primary)",
                  cursor: "pointer",
                  border: "none",
                  fontWeight: "600",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                Load Model
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>

            {/* Small circular gauge for context */}
            {(() => {
              const maxTokens = status.settings?.contextSize || 4096;
              const used = tokenUsage.total_tokens || 0;
              const percent = Math.min(100, Math.round((used / maxTokens) * 100));
              
              return (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }} title={`Context Used: ${used} / ${maxTokens} tokens`}>
                  <div style={{ position: "relative", width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="40" height="40" viewBox="0 0 40 40">
                      <circle cx="20" cy="20" r="16" stroke="var(--border-color)" strokeWidth="3" fill="transparent" />
                      <circle 
                        cx="20" 
                        cy="20" 
                        r="16" 
                        stroke="var(--md-sys-color-primary)" 
                        strokeWidth="3" 
                        fill="transparent" 
                        strokeDasharray={2 * Math.PI * 16}
                        strokeDashoffset={2 * Math.PI * 16 * (1 - percent / 100)}
                        strokeLinecap="round"
                        transform="rotate(-90 20 20)"
                        style={{ transition: "stroke-dashoffset 0.35s" }}
                      />
                    </svg>
                    <div style={{ position: "absolute", textAlign: "center" }}>
                      <span style={{ fontSize: "0.65rem", fontWeight: "700" }}>{percent}%</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                    <span style={{ fontSize: "0.65rem", color: "var(--md-sys-color-outline)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Context Used
                    </span>
                    <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "var(--md-sys-color-on-surface)" }}>
                      {used} / {maxTokens}
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Clear Conversation button */}
            <button 
              className="m3-btn m3-btn-outlined" 
              style={{ 
                height: "36px", 
                padding: "0 12px", 
                display: "flex", 
                alignItems: "center", 
                gap: "6px", 
                fontSize: "0.82rem",
                borderRadius: "var(--md-shape-corner-medium)"
              }}
              onClick={handleClearChat}
              disabled={messages.length === 0}
            >
              <Trash2 size={15} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div ref={chatMessagesRef} className="chat-messages">
          {loadingModel ? (
            <div className="chat-empty" style={{ maxWidth: "480px", margin: "auto", textAlign: "center", padding: "60px 20px" }}>
              <LoaderCircle className="progress-spinner" size={48} style={{ color: "var(--md-sys-color-primary)", marginBottom: "16px" }} />
              <h3 style={{ fontWeight: 600, fontSize: "1.25rem", marginBottom: "8px", color: "var(--md-sys-color-on-surface)" }}>Loading Text Model</h3>
              <code style={{ 
                display: "block", 
                background: "var(--md-sys-color-surface-variant)", 
                color: "var(--md-sys-color-on-surface-variant)",
                padding: "8px 12px", 
                borderRadius: "6px", 
                fontSize: "0.85rem",
                marginBottom: "20px",
                wordBreak: "break-all",
                fontFamily: "monospace"
              }}>
                {loadingModel}
              </code>
              <p style={{ fontSize: "0.9rem", color: "var(--md-sys-color-outline)", lineHeight: 1.5, marginBottom: "24px" }}>
                Initializing llama.cpp server and loading the model weights into memory. This can take up to 30 seconds depending on model size and hardware speed.
              </p>
              <button 
                className="m3-btn m3-btn-error" 
                onClick={handleCancelLlmLoad}
                style={{ 
                  display: "inline-flex", 
                  alignItems: "center", 
                  gap: "8px",
                  height: "38px",
                  padding: "0 16px",
                  fontSize: "0.85rem",
                  borderRadius: "var(--md-shape-corner-medium)"
                }}
              >
                <Square size={14} fill="currentColor" />
                <span>Cancel Load</span>
              </button>
            </div>
          ) : (
            <>
              {messages.length === 0 && (
                <div className="chat-empty">
                  <Bot size={42} />
                  <h3>Local ChatGPT-style Interface</h3>
                  <p>Choose a GGUF text model above to load it. Your conversation history stays completely private on this machine.</p>
                </div>
              )}
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`chat-message ${message.role} ${message.error ? "error" : ""}`}>
                  <strong>{message.role === "user" ? "You" : "Local AI"}</strong>
                  <div>
                    {Array.isArray(message.content) ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {message.content.map((item, idx) => {
                          if (item.type === "text") {
                            return <MarkdownRenderer key={idx} content={item.text} />;
                          }
                          if (item.type === "image_url") {
                            return (
                              <img 
                                key={idx} 
                                src={item.image_url.url} 
                                alt="Attached image" 
                                style={{ maxWidth: "240px", maxHeight: "180px", objectFit: "contain", borderRadius: "6px", marginTop: "4px" }} 
                              />
                            );
                          }
                          return null;
                        })}
                      </div>
                    ) : (
                      <MarkdownRenderer content={message.content} />
                    )}
                  </div>
                  {message.role === "assistant" && message.generationStats && !message.error && (
                    <div className={`chat-generation-stats ${message.generationStats.status}`}>
                      {message.generationStats.status === "starting" ? (
                        <>Waiting for first token...</>
                      ) : message.generationStats.status === "streaming" ? (
                        <>{message.generationStats.tokensPerSecond.toFixed(1)} tokens/sec</>
                      ) : (
                        <>
                          {message.generationStats.tokens} tokens
                          <span>•</span>
                          {formatGenerationTime(message.generationStats.seconds)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="chat-composer" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingBottom: "8px" }}>
              {attachments.map((att) => (
                <div key={att.id} style={{ 
                  position: "relative", 
                  display: "flex", 
                  alignItems: "center", 
                  gap: "6px", 
                  padding: "6px 28px 6px 8px", 
                  background: "var(--md-sys-color-surface-variant)", 
                  border: "1px solid var(--border-color)", 
                  borderRadius: "6px", 
                  fontSize: "0.8rem",
                  maxWidth: "200px"
                }}>
                  {att.type === "image" ? (
                    <img src={att.dataUrl} alt={att.name} style={{ width: "24px", height: "24px", objectFit: "cover", borderRadius: "3px" }} />
                  ) : (
                    <span style={{ fontWeight: 600 }}>📄</span>
                  )}
                  <span style={{ 
                    whiteSpace: "nowrap", 
                    overflow: "hidden", 
                    textOverflow: "ellipsis", 
                    color: "var(--md-sys-color-on-surface-variant)" 
                  }} title={att.name}>
                    {att.name}
                  </span>
                  <button 
                    onClick={() => setAttachments(prev => prev.filter(item => item.id !== att.id))}
                    style={{
                      position: "absolute",
                      right: "4px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "var(--md-sys-color-error)",
                      cursor: "pointer",
                      padding: "2px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center"
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", width: "100%" }}>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: "none" }} 
              multiple 
              onChange={handleFileChange} 
            />
            <button 
              className="m3-btn m3-btn-tonal" 
              onClick={() => fileInputRef.current?.click()} 
              style={{ padding: "0 12px", height: "48px", display: "flex", alignItems: "center", justifyContent: "center" }}
              disabled={!supportsVision || isBusy}
              title={supportsVision ? "Attach files or images" : "Image attachment requires a vision model with an mmproj file"}
            >
              <Paperclip size={17} />
            </button>

            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={status.ready ? "Message your local model..." : "Select and load a GGUF model above to begin"}
              disabled={!status.ready || isBusy}
              style={{ flex: 1 }}
            />
            {isBusy && status.ready ? (
              <button 
                className="m3-btn m3-btn-error" 
                onClick={handleStopGeneration} 
                style={{ height: "48px", display: "flex", alignItems: "center", gap: "6px" }}
              >
                <Square size={14} fill="currentColor" /> Stop
              </button>
            ) : (
              <button 
                className="m3-btn m3-btn-filled" 
                onClick={sendMessage} 
                disabled={(!input.trim() && attachments.length === 0) || !status.ready}
                style={{ height: "48px" }}
              >
                <Send size={17} /> Send
              </button>
            )}
          </div>
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
                  <ul key={blockIdx} style={{ margin: "4px 0 4px 20px", padding: 0, listStyleType: "disc", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {block.items.map((item, itemIdx) => (
                      <li key={itemIdx} style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{parseInlineMarkdown(item)}</li>
                    ))}
                  </ul>
                );
              case "ol":
                return (
                  <ol key={blockIdx} style={{ margin: "4px 0 4px 20px", padding: 0, listStyleType: "decimal", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {block.items.map((item, itemIdx) => (
                      <li key={itemIdx} style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{parseInlineMarkdown(item)}</li>
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
