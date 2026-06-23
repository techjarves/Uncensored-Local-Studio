import React, { memo, useState, useRef, useEffect } from "react";
import { Cpu, HardDrive, Database, Square, RefreshCw, Sun, Moon, Palette, Check } from "lucide-react";
import { THEMES } from "../themes";

function TopStatusBar({ telemetry, serverRunning, activeModel, isLlmLoaded = false, onStopServer, isStoppingServer = false, theme, setTheme }) {
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowThemeMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const formatGb = (value, { allowZero = false } = {}) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "--";
    if (number === 0 && !allowZero) return "--";
    return number.toFixed(number >= 10 ? 0 : 1);
  };

  const getStatusText = () => {
    if (isLlmLoaded) return "Model Loaded (Text)";
    if (activeModel) return "Model Loaded (Image)";
    if (serverRunning) return "Server Active";
    return "Local Mode";
  };

  const getStatusClass = () => {
    if (activeModel || isLlmLoaded) return "status-indicator";
    if (serverRunning) return "status-indicator busy";
    return "status-indicator offline";
  };

  const isDark = (theme || "dark").startsWith("dark");

  return (
    <div className="top-status-bar">
      <div className="current-model-info">
        <div className={getStatusClass()}></div>
        <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>
          {getStatusText()}
        </span>
        {activeModel && (
          <>
            <span style={{ color: "var(--md-sys-color-outline-variant)" }}>|</span>
            <span style={{ color: "var(--md-sys-color-primary)", fontWeight: 700 }}>
              {activeModel}
            </span>
          </>
        )}
      </div>

      <div className="telemetry-group" style={{ position: "relative" }}>
        <button
          className="theme-toggle-btn"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          title={`Switch to ${isDark ? "light" : "dark"} theme`}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
          <button
            className={`theme-toggle-btn ${showThemeMenu ? "active" : ""}`}
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            title="Choose a custom color theme"
            style={{ marginRight: "12px" }}
          >
            <Palette size={18} />
          </button>
          
          {showThemeMenu && (
            <div className="theme-dropdown-menu">
              <div className="theme-dropdown-header">Select Theme</div>
              <div className="theme-dropdown-divider"></div>
              {THEMES.map((t) => {
                const isActive = theme === t.id;
                return (
                  <button
                    key={t.id}
                    className={`theme-dropdown-item ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setTheme(t.id);
                      setShowThemeMenu(false);
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.primary }} />
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.secondary }} />
                      </div>
                      <span className="theme-name-text">{t.name}</span>
                      {isActive && <Check size={12} style={{ marginLeft: "auto", color: "var(--md-sys-color-primary)" }} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {serverRunning && (
          <button
            className="m3-btn m3-btn-error"
            style={{ height: "34px", padding: "0 14px" }}
            onClick={onStopServer}
            disabled={isStoppingServer}
            title="Stop local model server"
          >
            {isStoppingServer ? <RefreshCw className="progress-spinner" size={14} /> : <Square size={14} />}
            <span>{isStoppingServer ? "Stopping" : "Stop Server"}</span>
          </button>
        )}

        {/* CPU Telemetry Chip */}
        <div className="telemetry-chip" title="CPU Utilization">
          <Cpu className="telemetry-chip-icon" style={{ color: "var(--md-sys-color-primary)" }} />
          <span>CPU: {Number.isFinite(Number(telemetry.cpu_usage)) ? telemetry.cpu_usage : "--"}%</span>
        </div>

        {/* RAM Telemetry Chip */}
        <div className="telemetry-chip" title="System Memory Usage">
          <HardDrive className="telemetry-chip-icon" style={{ color: "var(--md-sys-color-secondary)" }} />
          <span>RAM: {formatGb(telemetry.ram_used_gb)} / {formatGb(telemetry.ram_total_gb)} GB</span>
        </div>

        {/* GPU VRAM Telemetry Chip */}
        {telemetry.vram_total_gb > 0 && (
          <div className="telemetry-chip" title={`${telemetry.gpu_name} VRAM`}>
            <Database className="telemetry-chip-icon" style={{ color: "var(--md-sys-color-tertiary)" }} />
            <span>VRAM: {formatGb(telemetry.vram_used_gb, { allowZero: true })} / {formatGb(telemetry.vram_total_gb)} GB</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(TopStatusBar);
