(() => {
  "use strict";

  const { useEffect, useMemo, useRef, useState } = React;
  const h = React.createElement;
  const STORAGE_KEY = "record-map-app-v2";
  const LEGACY_STORAGE_KEY = "record-map-app-v1";
  const MAX_AUDIO_SECONDS = 60;
  const CLUSTER_COLORS = ["#2f6f73", "#b4513f", "#6f5d9a", "#4f7d45", "#9b6a2f", "#4b6ea9", "#8a4f73", "#65723a"];
  const SAMPLE_CENTER = { latitude: 35.0116, longitude: 135.7681, accuracy: 18 };

  const initialData = {
    records: [],
    graphNodes: {},
    graphEdges: [],
    clusters: [],
    clusterMembers: [],
    schemaVersion: 2,
  };

  function uid(prefix) {
    if (window.crypto && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }

  function safeJsonParse(raw) {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  function normalizeData(input) {
    if (!input) return { ...initialData };
    const records = Array.isArray(input.records) ? input.records.map((record) => ({
      id: record.id || uid("record"),
      type: record.type || "text",
      title: record.title || defaultTitle(record.type || "text"),
      body: record.body || "",
      fileUrl: record.fileUrl || record.file_url || null,
      thumbnailUrl: record.thumbnailUrl || record.thumbnail_url || null,
      latitude: Number(record.latitude ?? SAMPLE_CENTER.latitude),
      longitude: Number(record.longitude ?? SAMPLE_CENTER.longitude),
      accuracy: Number(record.accuracy ?? 999),
      submittedAt: record.submittedAt || record.submitted_at || new Date().toISOString(),
      clusterId: record.clusterId || record.cluster_id || null,
      metadata: record.metadata || {},
    })) : [];

    const graphNodes = input.graphNodes || input.nodes || {};
    const normalizedNodes = {};
    records.forEach((record, index) => {
      const existing = graphNodes[record.id] || {};
      normalizedNodes[record.id] = {
        recordId: record.id,
        x: Number(existing.x ?? 80 + (index % 3) * 220),
        y: Number(existing.y ?? 80 + Math.floor(index / 3) * 150),
        width: Number(existing.width ?? 190),
        height: Number(existing.height ?? 112),
      };
    });

    const graphEdges = Array.isArray(input.graphEdges)
      ? input.graphEdges
      : Array.isArray(input.edges)
        ? input.edges.map((edge) => ({
          id: edge.id,
          sourceRecordId: edge.source || edge.sourceRecordId,
          targetRecordId: edge.target || edge.targetRecordId,
          weight: edge.weight ?? 1,
          label: edge.label || "",
        }))
        : [];

    return recalculateClusters({
      records,
      graphNodes: normalizedNodes,
      graphEdges: graphEdges
        .filter((edge) => edge.sourceRecordId && edge.targetRecordId && edge.sourceRecordId !== edge.targetRecordId)
        .map((edge) => ({
          id: edge.id || uid("edge"),
          sourceRecordId: edge.sourceRecordId,
          targetRecordId: edge.targetRecordId,
          weight: Number(edge.weight ?? 1),
          label: edge.label || "",
        })),
      clusters: Array.isArray(input.clusters) ? input.clusters : [],
      clusterMembers: Array.isArray(input.clusterMembers) ? input.clusterMembers : [],
      schemaVersion: 2,
    });
  }

  function loadData() {
    const current = safeJsonParse(localStorage.getItem(STORAGE_KEY));
    if (current) return normalizeData(current);
    const legacy = safeJsonParse(localStorage.getItem(LEGACY_STORAGE_KEY));
    return normalizeData(legacy);
  }

  function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, schemaVersion: 2 }));
  }

  function defaultTitle(type) {
    if (type === "photo") return "無題の写真";
    if (type === "audio") return "無題の音声";
    return "無題のテキスト";
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function recordIcon(type) {
    if (type === "photo") return "写";
    if (type === "audio") return "音";
    return "文";
  }

  function typeLabel(type) {
    if (type === "photo") return "写真";
    if (type === "audio") return "音声";
    return "テキスト";
  }

  function truncate(text, length) {
    if (!text) return "";
    return text.length > length ? `${text.slice(0, length)}...` : text;
  }

  function getCluster(data, clusterId) {
    return data.clusters.find((cluster) => cluster.id === clusterId) || null;
  }

  function getClusterColor(data, clusterId) {
    return getCluster(data, clusterId)?.color || "#242424";
  }

  function sameMembers(a = [], b = []) {
    return a.length === b.length && a.every((id) => b.includes(id));
  }

  function calculateCenter(records) {
    if (!records.length) return { latitude: 0, longitude: 0 };
    return {
      latitude: records.reduce((sum, record) => sum + record.latitude, 0) / records.length,
      longitude: records.reduce((sum, record) => sum + record.longitude, 0) / records.length,
    };
  }

  function recalculateClusters(data) {
    const graph = new Map();
    data.records.forEach((record) => graph.set(record.id, new Set()));
    data.graphEdges.forEach((edge) => {
      if (!graph.has(edge.sourceRecordId) || !graph.has(edge.targetRecordId)) return;
      graph.get(edge.sourceRecordId).add(edge.targetRecordId);
      graph.get(edge.targetRecordId).add(edge.sourceRecordId);
    });

    const visited = new Set();
    const components = [];
    data.records.forEach((record) => {
      if (visited.has(record.id)) return;
      const stack = [record.id];
      const memberIds = [];
      visited.add(record.id);
      while (stack.length) {
        const current = stack.pop();
        memberIds.push(current);
        for (const next of graph.get(current) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            stack.push(next);
          }
        }
      }
      components.push(memberIds);
    });

    const clusters = components.map((memberIds, index) => {
      const existing = data.clusters.find((cluster) => sameMembers(cluster.recordIds, memberIds));
      const memberRecords = memberIds.map((id) => data.records.find((record) => record.id === id)).filter(Boolean);
      const center = calculateCenter(memberRecords);
      return {
        id: existing?.id || uid("cluster"),
        name: existing?.name || `Cluster ${index + 1}`,
        description: existing?.description || "",
        recordIds: memberIds,
        centerLatitude: center.latitude,
        centerLongitude: center.longitude,
        color: existing?.color || CLUSTER_COLORS[index % CLUSTER_COLORS.length],
        metadata: {
          method: "connected-components",
          source: "graph_edges",
        },
      };
    });

    const records = data.records.map((record) => {
      const cluster = clusters.find((item) => item.recordIds.includes(record.id));
      return { ...record, clusterId: cluster?.id || null };
    });

    const clusterMembers = clusters.flatMap((cluster) =>
      cluster.recordIds.map((recordId) => ({ clusterId: cluster.id, recordId, score: 1 }))
    );

    return { ...data, records, clusters, clusterMembers, schemaVersion: 2 };
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const radius = 6371000;
    const toRad = (degree) => (degree * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function proximityState(distance, accuracy = 0) {
    if (distance == null) return "unknown";
    const relaxed = Math.max(0, distance - Math.max(0, accuracy) * 0.35);
    if (relaxed < 10) return "very-near";
    if (relaxed < 30) return "near";
    if (relaxed < 100) return "visible";
    return "far";
  }

  function getCurrentPosition(options = {}) {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("このブラウザでは位置情報を取得できません。"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
        ...options,
      });
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function imageToCompressedDataUrl(file) {
    if (!file.type.startsWith("image/")) return fileToDataUrl(file);
    const original = await fileToDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = original;
    });
    const maxSize = 1400;
    const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * ratio));
    canvas.height = Math.max(1, Math.round(img.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  }

  function createProjector(points, width, height) {
    const usableWidth = Math.max(1, width || 1);
    const usableHeight = Math.max(1, height || 1);
    const pad = Math.min(56, Math.max(26, usableWidth * 0.08));
    let minLat = Math.min(...points.map((p) => p.latitude));
    let maxLat = Math.max(...points.map((p) => p.latitude));
    let minLng = Math.min(...points.map((p) => p.longitude));
    let maxLng = Math.max(...points.map((p) => p.longitude));
    if (minLat === maxLat) { minLat -= 0.0005; maxLat += 0.0005; }
    if (minLng === maxLng) { minLng -= 0.0005; maxLng += 0.0005; }
    return (point) => ({
      x: pad + ((point.longitude - minLng) / (maxLng - minLng)) * Math.max(1, usableWidth - pad * 2),
      y: pad + (1 - (point.latitude - minLat) / (maxLat - minLat)) * Math.max(1, usableHeight - pad * 2),
    });
  }

  function App() {
    const [data, setData] = useState(loadData);
    const [page, setPage] = useState("submit");
    const [selectedRecordIds, setSelectedRecordIds] = useState([]);
    const [activeClusterId, setActiveClusterId] = useState(null);
    const [toast, setToast] = useState("");

    useEffect(() => saveData(data), [data]);
    useEffect(() => {
      if (!toast) return undefined;
      const timer = setTimeout(() => setToast(""), 3600);
      return () => clearTimeout(timer);
    }, [toast]);

    function updateData(updater, message) {
      setData((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        return normalizeData(next);
      });
      if (message) setToast(message);
    }

    const storageSize = useMemo(() => {
      try {
        return Math.round((localStorage.getItem(STORAGE_KEY) || "").length / 1024);
      } catch {
        return 0;
      }
    }, [data]);

    return h("div", { className: "app-shell" },
      h("header", { className: "app-header" },
        h("div", { className: "title-block" },
          h("p", { className: "kicker" }, "習作11-1"),
          h("h1", null, "記録物マッピング"),
          h("p", null, "投稿時の推定位置、編集上の関係、クラスタ、歩行中の探索を分けて扱うプロトタイプ")
        ),
        h("nav", { className: "tabs", "aria-label": "ページ切り替え" },
          ["submit", "edit", "explore", "data"].map((id) =>
            h("button", {
              key: id,
              type: "button",
              className: page === id ? "tab active" : "tab",
              onClick: () => setPage(id),
            }, ({ submit: "送信", edit: "編集", explore: "探索", data: "データ" })[id])
          )
        )
      ),
      toast ? h("div", { className: "toast", role: "status" }, toast) : null,
      h("main", null,
        page === "submit" && h(SubmitPage, { data, updateData, setPage, setToast }),
        page === "edit" && h(EditPage, { data, updateData, selectedRecordIds, setSelectedRecordIds, setToast }),
        page === "explore" && h(ExplorePage, { data, activeClusterId, setActiveClusterId }),
        page === "data" && h(DataPage, { data, updateData, storageSize, setToast })
      )
    );
  }

  function SubmitPage({ data, updateData, setPage, setToast }) {
    const [type, setType] = useState("text");
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [photoUrl, setPhotoUrl] = useState(null);
    const [audioUrl, setAudioUrl] = useState(null);
    const [audioMode, setAudioMode] = useState("record");
    const [location, setLocation] = useState(null);
    const [manualLocation, setManualLocation] = useState({
      latitude: SAMPLE_CENTER.latitude,
      longitude: SAMPLE_CENTER.longitude,
      accuracy: 999,
    });
    const [status, setStatus] = useState("");
    const [recording, setRecording] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const recorderRef = useRef(null);
    const chunksRef = useRef([]);
    const streamRef = useRef(null);
    const timerRef = useRef(null);
    const supportsRecording = !!(navigator.mediaDevices && window.MediaRecorder);

    useEffect(() => () => stopTracks(), []);

    function stopTracks() {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    async function captureLocation() {
      setStatus("投稿時の推定位置を取得しています。");
      try {
        const pos = await getCurrentPosition();
        const next = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        setLocation(next);
        setManualLocation(next);
        setStatus("投稿時の推定位置を取得しました。");
      } catch (error) {
        setStatus(`位置情報を取得できませんでした。HTTPS、権限、端末設定を確認してください。(${error.message})`);
      }
    }

    async function handlePhoto(file) {
      if (!file) return;
      setStatus("写真を圧縮しています。");
      try {
        const dataUrl = await imageToCompressedDataUrl(file);
        setPhotoUrl(dataUrl);
        setStatus("写真を読み込みました。");
      } catch (error) {
        setStatus(`写真を読み込めませんでした。${error.message}`);
      }
    }

    async function handleAudioFile(file) {
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      setAudioUrl(dataUrl);
      setStatus("音声ファイルを読み込みました。");
    }

    async function startRecording() {
      if (!supportsRecording) {
        setAudioMode("upload");
        setStatus("このブラウザでは録音できないため、音声ファイル選択に切り替えました。");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];
        const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          setAudioUrl(await fileToDataUrl(blob));
          setRecording(false);
          stopTracks();
          setStatus("音声を保存しました。");
        };
        recorder.start();
        setSeconds(0);
        setRecording(true);
        setStatus("録音中です。最大60秒で自動停止します。");
        timerRef.current = setInterval(() => {
          setSeconds((current) => {
            const next = current + 1;
            if (next >= MAX_AUDIO_SECONDS) stopRecording();
            return Math.min(MAX_AUDIO_SECONDS, next);
          });
        }, 1000);
      } catch (error) {
        setAudioMode("upload");
        setStatus(`録音を開始できませんでした。音声ファイル選択に切り替えました。(${error.message})`);
      }
    }

    function stopRecording() {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    }

    function applyManualLocation() {
      const next = {
        latitude: Number(manualLocation.latitude),
        longitude: Number(manualLocation.longitude),
        accuracy: Number(manualLocation.accuracy || 999),
      };
      if (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) {
        setStatus("緯度・経度を数値で入力してください。");
        return;
      }
      setLocation(next);
      setStatus("手入力の推定位置を設定しました。");
    }

    function submit(event) {
      event.preventDefault();
      const trimmedBody = body.trim();
      if (!location) {
        setStatus("投稿前に、投稿時の推定位置を取得または設定してください。");
        return;
      }
      if (type === "text" && !trimmedBody) {
        setStatus("テキストを入力してください。");
        return;
      }
      if (type === "photo" && !photoUrl) {
        setStatus("写真を選択してください。");
        return;
      }
      if (type === "audio" && !audioUrl) {
        setStatus("音声を録音、または音声ファイルを選択してください。");
        return;
      }

      const record = {
        id: uid("record"),
        type,
        title: title.trim() || defaultTitle(type),
        body: type === "text" ? trimmedBody : "",
        fileUrl: type === "photo" ? photoUrl : type === "audio" ? audioUrl : null,
        thumbnailUrl: type === "photo" ? photoUrl : null,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        submittedAt: new Date().toISOString(),
        clusterId: null,
        metadata: {
          source: "browser",
          audioMaxDurationSeconds: type === "audio" ? MAX_AUDIO_SECONDS : undefined,
          userAgent: navigator.userAgent,
        },
      };

      updateData((current) => {
        const index = current.records.length;
        return recalculateClusters({
          ...current,
          records: [...current.records, record],
          graphNodes: {
            ...current.graphNodes,
            [record.id]: {
              recordId: record.id,
              x: 70 + (index % 3) * 230,
              y: 70 + Math.floor(index / 3) * 150,
              width: 190,
              height: 112,
            },
          },
        });
      }, "記録物を保存しました。");

      setTitle("");
      setBody("");
      setPhotoUrl(null);
      setAudioUrl(null);
      setStatus("");
      setPage("edit");
    }

    return h("section", { className: "page submit-page" },
      h(PageHead, {
        title: "送信ページ",
        body: "その場で得た記録を、投稿時の推定位置と一緒に保存します。位置は完全な値ではなく、推定精度とセットで扱います。",
      }),
      h("div", { className: "submit-layout" },
        h("form", { className: "panel form-panel", onSubmit: submit },
          h(Segmented, {
            label: "記録タイプ",
            value: type,
            onChange: (next) => setType(next),
            options: [
              { value: "text", label: "テキスト" },
              { value: "photo", label: "写真" },
              { value: "audio", label: "音声" },
            ],
          }),
          h("label", null, "タイトル", h("input", {
            value: title,
            onChange: (event) => setTitle(event.target.value),
            placeholder: "例：路地の植木鉢",
          })),
          type === "text" && h("label", null, "テキスト", h("textarea", {
            value: body,
            onChange: (event) => setBody(event.target.value),
            rows: 7,
            placeholder: "見えたもの、聞こえたもの、ふるまい、気配など",
          })),
          type === "photo" && h("div", { className: "input-block" },
            h("label", null, "写真", h("input", {
              type: "file",
              accept: "image/*",
              onChange: (event) => handlePhoto(event.target.files?.[0]),
            })),
            photoUrl && h("img", { className: "media-preview", src: photoUrl, alt: "写真プレビュー" })
          ),
          type === "audio" && h("div", { className: "input-block" },
            h(Segmented, {
              label: "音声入力",
              value: audioMode,
              onChange: (next) => setAudioMode(next),
              options: [
                { value: "record", label: "録音" },
                { value: "upload", label: "ファイル" },
              ],
            }),
            audioMode === "record" && h("div", { className: "audio-box" },
              h("div", { className: "toolbar" },
                h("button", { type: "button", onClick: startRecording, disabled: recording }, "録音開始"),
                h("button", { type: "button", onClick: stopRecording, disabled: !recording }, "録音停止"),
                h("span", { className: recording ? "timer recording" : "timer" }, `00:${String(seconds).padStart(2, "0")}`)
              ),
              !supportsRecording && h("p", { className: "note strong" }, "このブラウザでは録音できない可能性があります。ファイル選択を使ってください。")
            ),
            audioMode === "upload" && h("label", null, "音声ファイル", h("input", {
              type: "file",
              accept: "audio/*",
              onChange: (event) => handleAudioFile(event.target.files?.[0]),
            })),
            audioUrl && h("audio", { className: "audio-preview", src: audioUrl, controls: true })
          ),
          h(LocationPanel, {
            location,
            status,
            manualLocation,
            setManualLocation,
            captureLocation,
            applyManualLocation,
          }),
          h("button", { className: "primary action", type: "submit" }, "記録物を保存")
        ),
        h("aside", { className: "panel context-panel" },
          h("h2", null, "保存される構造"),
          h("dl", { className: "data-dl" },
            h("dt", null, "地理的位置"), h("dd", null, "records.latitude / longitude / accuracy"),
            h("dt", null, "編集座標"), h("dd", null, "graphNodes.x / y"),
            h("dt", null, "関係線"), h("dd", null, "graphEdges.sourceRecordId / targetRecordId"),
            h("dt", null, "クラスタ"), h("dd", null, "リンク構造から作る connected components")
          ),
          h("div", { className: "location-preview" },
            location
              ? h(React.Fragment, null,
                h("span", { className: "map-pin" }, "現"),
                h("strong", null, `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`),
                h("small", null, `推定精度 ±${Math.round(location.accuracy)}m`)
              )
              : h("span", null, "投稿時の推定位置を取得すると、ここに表示されます。")
          ),
          h("p", { className: "note" }, `現在の記録数: ${data.records.length}件`)
        )
      )
    );
  }

  function LocationPanel({ location, status, manualLocation, setManualLocation, captureLocation, applyManualLocation }) {
    return h("fieldset", { className: "location-box" },
      h("legend", null, "投稿時の推定位置"),
      h("div", { className: "toolbar wrap" },
        h("button", { type: "button", onClick: captureLocation }, "現在地を取得"),
        h("button", { type: "button", onClick: applyManualLocation }, "手入力を設定")
      ),
      h("div", { className: "location-readout" },
        h("span", null, "緯度: ", h("strong", null, location ? location.latitude.toFixed(7) : "未設定")),
        h("span", null, "経度: ", h("strong", null, location ? location.longitude.toFixed(7) : "未設定")),
        h("span", null, "推定精度: ", h("strong", null, location ? `±${Math.round(location.accuracy)}m` : "未設定"))
      ),
      h("details", { className: "manual-location" },
        h("summary", null, "位置が取れない場合の手入力"),
        h("div", { className: "manual-grid" },
          h("label", null, "緯度", h("input", {
            inputMode: "decimal",
            value: manualLocation.latitude,
            onChange: (event) => setManualLocation({ ...manualLocation, latitude: event.target.value }),
          })),
          h("label", null, "経度", h("input", {
            inputMode: "decimal",
            value: manualLocation.longitude,
            onChange: (event) => setManualLocation({ ...manualLocation, longitude: event.target.value }),
          })),
          h("label", null, "推定精度(m)", h("input", {
            inputMode: "numeric",
            value: manualLocation.accuracy,
            onChange: (event) => setManualLocation({ ...manualLocation, accuracy: event.target.value }),
          }))
        )
      ),
      status && h("p", { className: "status" }, status)
    );
  }

  function EditPage({ data, updateData, selectedRecordIds, setSelectedRecordIds, setToast }) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const [linkLabel, setLinkLabel] = useState("");
    const [dragging, setDragging] = useState(null);
    const canvasRef = useRef(null);

    const records = data.records.filter((record) => {
      const text = `${record.title} ${record.body}`.toLowerCase();
      return (filter === "all" || record.type === filter) && text.includes(query.toLowerCase());
    });

    const selectedRecords = selectedRecordIds.map((id) => data.records.find((record) => record.id === id)).filter(Boolean);

    function toggleSelected(id) {
      setSelectedRecordIds((current) => {
        if (current.includes(id)) return current.filter((item) => item !== id);
        return [...current, id].slice(-2);
      });
    }

    function createLink() {
      if (selectedRecordIds.length !== 2) {
        setToast("リンクを作るには記録物を2つ選んでください。");
        return;
      }
      const [sourceRecordId, targetRecordId] = selectedRecordIds;
      updateData((current) => {
        const exists = current.graphEdges.some((edge) =>
          (edge.sourceRecordId === sourceRecordId && edge.targetRecordId === targetRecordId) ||
          (edge.sourceRecordId === targetRecordId && edge.targetRecordId === sourceRecordId)
        );
        if (exists) return current;
        return recalculateClusters({
          ...current,
          graphEdges: [...current.graphEdges, {
            id: uid("edge"),
            sourceRecordId,
            targetRecordId,
            weight: 1,
            label: linkLabel.trim(),
          }],
        });
      }, "リンク線を作成し、クラスタを更新しました。");
      setLinkLabel("");
    }

    function deleteLink(edgeId) {
      updateData((current) => recalculateClusters({
        ...current,
        graphEdges: current.graphEdges.filter((edge) => edge.id !== edgeId),
      }), "リンク線を削除しました。");
    }

    function autoLayout() {
      updateData((current) => {
        const centerX = 380;
        const centerY = 260;
        const radius = Math.max(150, Math.min(280, current.records.length * 42));
        const graphNodes = { ...current.graphNodes };
        current.records.forEach((record, index) => {
          const angle = (Math.PI * 2 * index) / Math.max(1, current.records.length);
          graphNodes[record.id] = {
            ...(graphNodes[record.id] || { recordId: record.id, width: 190, height: 112 }),
            x: centerX + Math.cos(angle) * radius,
            y: centerY + Math.sin(angle) * radius,
          };
        });
        return { ...current, graphNodes };
      }, "編集座標を自動配置しました。");
    }

    function nudgeSelected(dx, dy) {
      if (!selectedRecordIds.length) {
        setToast("移動する記録物を選択してください。");
        return;
      }
      updateData((current) => {
        const graphNodes = { ...current.graphNodes };
        selectedRecordIds.forEach((id) => {
          const node = graphNodes[id] || { recordId: id, x: 0, y: 0, width: 190, height: 112 };
          graphNodes[id] = { ...node, x: Math.max(0, node.x + dx), y: Math.max(0, node.y + dy) };
        });
        return { ...current, graphNodes };
      });
    }

    function startDrag(event, id) {
      const node = data.graphNodes[id];
      if (!node) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging({ id, startX: event.clientX, startY: event.clientY, initialX: node.x, initialY: node.y });
      setSelectedRecordIds((current) => current.includes(id) ? current : [...current, id].slice(-2));
    }

    function moveDrag(event) {
      if (!dragging) return;
      const dx = event.clientX - dragging.startX;
      const dy = event.clientY - dragging.startY;
      updateData((current) => ({
        ...current,
        graphNodes: {
          ...current.graphNodes,
          [dragging.id]: {
            ...(current.graphNodes[dragging.id] || { recordId: dragging.id, width: 190, height: 112 }),
            x: Math.max(0, dragging.initialX + dx),
            y: Math.max(0, dragging.initialY + dy),
          },
        },
      }));
    }

    return h("section", { className: "page edit-page" },
      h(PageHead, {
        title: "編集ページ",
        body: "記録物を編集空間に置き直し、関係があると思うもの同士を線でつなぎます。クラスタはこの線から作ります。",
      }),
      h("div", { className: "edit-layout" },
        h("aside", { className: "panel side-panel" },
          h("h2", null, "記録物"),
          h("div", { className: "toolbar vertical" },
            h("input", { type: "search", placeholder: "検索", value: query, onChange: (event) => setQuery(event.target.value) }),
            h("select", { value: filter, onChange: (event) => setFilter(event.target.value) },
              h("option", { value: "all" }, "すべて"),
              h("option", { value: "text" }, "テキスト"),
              h("option", { value: "photo" }, "写真"),
              h("option", { value: "audio" }, "音声")
            ),
            h("button", { type: "button", onClick: autoLayout }, "自動配置"),
            h("button", { type: "button", onClick: () => updateData(recalculateClusters(data), "クラスタを再計算しました。") }, "クラスタ再計算")
          ),
          h("div", { className: "record-list" },
            records.length ? records.map((record) =>
              h(RecordCard, {
                key: record.id,
                record,
                cluster: getCluster(data, record.clusterId),
                selected: selectedRecordIds.includes(record.id),
                onClick: () => toggleSelected(record.id),
              })
            ) : h("p", { className: "note" }, "記録物がありません。")
          )
        ),
        h("section", { className: "panel canvas-panel" },
          h("div", { className: "canvas-toolbar" },
            h("span", null, "編集座標 x/y は現実の緯度経度とは別です。"),
            h("div", { className: "toolbar compact" },
              h("button", { type: "button", onClick: () => setSelectedRecordIds([]) }, "選択解除"),
              h("button", { type: "button", onClick: createLink }, "リンク作成")
            )
          ),
          h("div", {
            className: "edit-canvas",
            ref: canvasRef,
            onPointerMove: moveDrag,
            onPointerUp: () => setDragging(null),
            onPointerCancel: () => setDragging(null),
          },
            h("svg", { className: "edge-layer", viewBox: "0 0 900 650", preserveAspectRatio: "none" },
              data.graphEdges.map((edge) => {
                const a = data.graphNodes[edge.sourceRecordId];
                const b = data.graphNodes[edge.targetRecordId];
                if (!a || !b) return null;
                return h("line", {
                  key: edge.id,
                  x1: a.x + 95,
                  y1: a.y + 56,
                  x2: b.x + 95,
                  y2: b.y + 56,
                  stroke: getClusterColor(data, data.records.find((record) => record.id === edge.sourceRecordId)?.clusterId),
                  strokeWidth: 2.5,
                });
              })
            ),
            data.records.map((record) => {
              const node = data.graphNodes[record.id] || { x: 0, y: 0 };
              return h("button", {
                key: record.id,
                type: "button",
                className: selectedRecordIds.includes(record.id) ? "record-node selected" : "record-node",
                style: { left: `${node.x}px`, top: `${node.y}px`, borderColor: getClusterColor(data, record.clusterId) },
                onPointerDown: (event) => startDrag(event, record.id),
              },
                h("span", { className: "node-type" }, typeLabel(record.type)),
                h("strong", null, record.title),
                h("small", null, record.type === "text" ? truncate(record.body, 56) : `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`),
                record.thumbnailUrl && h("img", { src: record.thumbnailUrl, alt: "" })
              );
            })
          ),
          h("div", { className: "mobile-nudge" },
            h("span", null, "スマホ用の配置調整"),
            h("div", { className: "nudge-grid" },
              h("button", { type: "button", onClick: () => nudgeSelected(0, -24) }, "上"),
              h("button", { type: "button", onClick: () => nudgeSelected(-24, 0) }, "左"),
              h("button", { type: "button", onClick: () => nudgeSelected(24, 0) }, "右"),
              h("button", { type: "button", onClick: () => nudgeSelected(0, 24) }, "下")
            )
          )
        ),
        h("aside", { className: "panel side-panel" },
          h("h2", null, "選択とクラスタ"),
          h("div", { className: "selection-box" },
            selectedRecords.length
              ? selectedRecords.map((record) => h("p", { key: record.id }, h("strong", null, record.title), h("br"), h("span", null, `${typeLabel(record.type)} / ${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`)))
              : h("p", { className: "note" }, "記録物を2つ選ぶとリンクを作れます。")
          ),
          h("label", null, "リンク理由", h("input", {
            value: linkLabel,
            onChange: (event) => setLinkLabel(event.target.value),
            placeholder: "例：同じ水音が聞こえる",
          })),
          h("button", { className: "primary action", type: "button", onClick: createLink }, "選択中の2件をつなぐ"),
          h("h3", null, "リンク線"),
          h("div", { className: "edge-list" },
            data.graphEdges.length ? data.graphEdges.map((edge) => {
              const a = data.records.find((record) => record.id === edge.sourceRecordId);
              const b = data.records.find((record) => record.id === edge.targetRecordId);
              return h("article", { key: edge.id, className: "edge-card" },
                h("strong", null, `${a?.title || "?"} - ${b?.title || "?"}`),
                edge.label && h("p", null, edge.label),
                h("button", { type: "button", onClick: () => deleteLink(edge.id) }, "削除")
              );
            }) : h("p", { className: "note" }, "リンク線はまだありません。")
          ),
          h("h3", null, "クラスタ"),
          h(ClusterList, { data })
        )
      )
    );
  }

  function ExplorePage({ data, activeClusterId, setActiveClusterId }) {
    const [userLocation, setUserLocation] = useState(null);
    const [watching, setWatching] = useState(false);
    const [status, setStatus] = useState("現在地は未取得です。");
    const [radius, setRadius] = useState(100);
    const [mode, setMode] = useState("near");
    const [selectedRecordId, setSelectedRecordId] = useState(null);
    const [mapSize, setMapSize] = useState({ width: 800, height: 520 });
    const watchRef = useRef(null);
    const mapRef = useRef(null);

    useEffect(() => {
      const update = () => {
        if (!mapRef.current) return;
        const rect = mapRef.current.getBoundingClientRect();
        setMapSize({ width: rect.width, height: rect.height });
      };
      update();
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }, []);

    useEffect(() => () => stopWatch(), []);

    function startWatch() {
      if (!("geolocation" in navigator)) {
        setStatus("このブラウザでは位置情報を取得できません。");
        return;
      }
      watchRef.current = navigator.geolocation.watchPosition((pos) => {
        const next = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        setUserLocation(next);
        setWatching(true);
        setStatus(`現在地を追跡中: ${next.latitude.toFixed(5)}, ${next.longitude.toFixed(5)} / 推定精度 ±${Math.round(next.accuracy)}m`);
      }, (error) => {
        setStatus(`現在地を追跡できません。${error.message}`);
        setWatching(false);
      }, {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 12000,
      });
      setWatching(true);
    }

    function stopWatch() {
      if (watchRef.current != null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watchRef.current);
      }
      watchRef.current = null;
      setWatching(false);
    }

    function useSampleLocation() {
      setUserLocation(SAMPLE_CENTER);
      setStatus("確認用の現在地を設定しました。実地利用時は現在地追跡を開始してください。");
    }

    const points = data.records.map((record) => ({ latitude: record.latitude, longitude: record.longitude }));
    if (userLocation) points.push(userLocation);
    if (!points.length) points.push(SAMPLE_CENTER);
    const projector = createProjector(points, mapSize.width, mapSize.height);

    const enriched = data.records.map((record) => {
      const distance = userLocation ? distanceMeters(userLocation.latitude, userLocation.longitude, record.latitude, record.longitude) : null;
      const clusterActive = activeClusterId && record.clusterId === activeClusterId;
      const state = proximityState(distance, userLocation?.accuracy || 0);
      return { record, distance, clusterActive, state };
    });

    const nearby = enriched
      .filter((item) => item.distance == null || radius === 999999 || item.distance <= radius || item.clusterActive)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

    const selectedRecord = data.records.find((record) => record.id === selectedRecordId) || nearby[0]?.record || null;
    const visibleEdges = mode === "relations" || mode === "clusters" || activeClusterId;

    return h("section", { className: "page explore-page" },
      h(PageHead, {
        title: "探索ページ",
        body: "記録物は元の投稿地点に置き、近づいた記録物と同じクラスタの記録物を同時に強調します。",
      }),
      h("div", { className: "explore-layout" },
        h("section", { className: "panel map-panel" },
          h("div", { className: "map-toolbar" },
            h("div", { className: "toolbar wrap" },
              h("button", { type: "button", onClick: startWatch, disabled: watching }, "現在地追跡"),
              h("button", { type: "button", onClick: stopWatch, disabled: !watching }, "停止"),
              h("button", { type: "button", onClick: useSampleLocation }, "確認用位置")
            ),
            h("span", { className: "status inline" }, status)
          ),
          h("div", { className: "abstract-map", ref: mapRef },
            h("svg", { className: "map-lines", viewBox: `0 0 ${mapSize.width} ${mapSize.height}` },
              visibleEdges && data.graphEdges.map((edge) => {
                const a = data.records.find((record) => record.id === edge.sourceRecordId);
                const b = data.records.find((record) => record.id === edge.targetRecordId);
                if (!a || !b) return null;
                if (activeClusterId && a.clusterId !== activeClusterId && b.clusterId !== activeClusterId) return null;
                const pa = projector(a);
                const pb = projector(b);
                return h("line", {
                  key: edge.id,
                  x1: pa.x,
                  y1: pa.y,
                  x2: pb.x,
                  y2: pb.y,
                  stroke: getClusterColor(data, a.clusterId),
                  strokeWidth: 2,
                });
              })
            ),
            data.records.map((record) => {
              const p = projector(record);
              const item = enriched.find((entry) => entry.record.id === record.id);
              const hiddenByRadius = item.distance != null && radius !== 999999 && item.distance > radius && mode === "near" && !item.clusterActive;
              const isSelected = selectedRecordId === record.id;
              return h("button", {
                key: record.id,
                type: "button",
                className: `map-marker ${item.state} ${item.clusterActive ? "cluster-active" : ""} ${isSelected ? "selected" : ""} ${hiddenByRadius ? "dimmed" : ""}`,
                style: {
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  borderColor: getClusterColor(data, record.clusterId),
                  background: mode === "clusters" || item.clusterActive ? getClusterColor(data, record.clusterId) : "#fffdfa",
                },
                title: record.title,
                onClick: () => {
                  setSelectedRecordId(record.id);
                  setActiveClusterId(record.clusterId);
                },
              }, recordIcon(record.type));
            }),
            userLocation && h("div", {
              className: "user-marker",
              style: { left: `${projector(userLocation).x}px`, top: `${projector(userLocation).y}px` },
              title: `推定精度 ±${Math.round(userLocation.accuracy)}m`,
            })
          )
        ),
        h("aside", { className: "panel explore-panel" },
          h("h2", null, "探索設定"),
          h("label", null, "表示半径", h("select", { value: radius, onChange: (event) => setRadius(Number(event.target.value)) },
            h("option", { value: 30 }, "30m"),
            h("option", { value: 100 }, "100m"),
            h("option", { value: 300 }, "300m"),
            h("option", { value: 1000 }, "1000m"),
            h("option", { value: 999999 }, "すべて")
          )),
          h("label", null, "表示モード", h("select", { value: mode, onChange: (event) => setMode(event.target.value) },
            h("option", { value: "near" }, "近接"),
            h("option", { value: "clusters" }, "クラスタ"),
            h("option", { value: "relations" }, "関係線")
          )),
          h("label", null, "クラスタ", h("select", {
            value: activeClusterId || "",
            onChange: (event) => setActiveClusterId(event.target.value || null),
          },
            h("option", { value: "" }, "自動 / 未選択"),
            data.clusters.map((cluster) => h("option", { key: cluster.id, value: cluster.id }, `${cluster.name} (${cluster.recordIds.length})`))
          )),
          selectedRecord && h("article", { className: "record-detail" },
            h("h3", null, selectedRecord.title),
            h("p", null, `${typeLabel(selectedRecord.type)} / 投稿時の推定位置 ${selectedRecord.latitude.toFixed(5)}, ${selectedRecord.longitude.toFixed(5)}`),
            h("p", { className: "note" }, `推定精度 ±${Math.round(selectedRecord.accuracy)}m / ${getCluster(data, selectedRecord.clusterId)?.name || "クラスタなし"}`),
            selectedRecord.body && h("p", null, selectedRecord.body),
            selectedRecord.type === "photo" && selectedRecord.fileUrl && h("img", { src: selectedRecord.fileUrl, alt: selectedRecord.title }),
            selectedRecord.type === "audio" && selectedRecord.fileUrl && h("audio", { src: selectedRecord.fileUrl, controls: true })
          ),
          h("h3", null, `範囲内・関連 ${nearby.length}件`),
          h("div", { className: "nearby-list" },
            nearby.length ? nearby.map((item) => h(RecordCard, {
              key: item.record.id,
              record: item.record,
              cluster: getCluster(data, item.record.clusterId),
              meta: item.distance == null ? "距離未計算" : `${Math.round(item.distance)}m / ${stateLabel(item.state)}`,
              selected: selectedRecordId === item.record.id,
              onClick: () => {
                setSelectedRecordId(item.record.id);
                setActiveClusterId(item.record.clusterId);
              },
            })) : h("p", { className: "note" }, "表示できる記録物がありません。")
          )
        )
      )
    );
  }

  function stateLabel(state) {
    return ({ "very-near": "かなり近い", near: "近い", visible: "見える範囲", far: "遠い", unknown: "未計算" })[state] || state;
  }

  function DataPage({ data, updateData, storageSize, setToast }) {
    const fileRef = useRef(null);

    function seedData() {
      updateData((current) => {
        const samples = [
          ["text", "ベンチの横", "座面の下に落ち葉が溜まっている。誰かが長く座った痕跡のように見える。", 0, 0],
          ["text", "細い抜け道", "人がすれ違うときだけ、身体の向きが一瞬変わる。", 0.00035, 0.00016],
          ["photo", "壁際の鉢", "", -0.00022, 0.00028],
          ["audio", "水の音", "", 0.00048, -0.0002],
          ["text", "段差の前", "小さな段差が、進む向きや身体の速度を少し変えている。", -0.00042, -0.00038],
        ];
        const records = [...current.records];
        const graphNodes = { ...current.graphNodes };
        const newIds = [];
        samples.forEach(([type, title, body, dLat, dLng], index) => {
          const id = uid("record");
          newIds.push(id);
          records.push({
            id,
            type,
            title,
            body,
            fileUrl: type === "photo" ? sampleImageDataUrl() : null,
            thumbnailUrl: type === "photo" ? sampleImageDataUrl() : null,
            latitude: SAMPLE_CENTER.latitude + dLat,
            longitude: SAMPLE_CENTER.longitude + dLng,
            accuracy: 12 + index * 3,
            submittedAt: new Date(Date.now() - index * 3600000).toISOString(),
            clusterId: null,
            metadata: { sample: true },
          });
          graphNodes[id] = { recordId: id, x: 80 + index * 145, y: 90 + (index % 2) * 180, width: 190, height: 112 };
        });
        const graphEdges = [
          ...current.graphEdges,
          { id: uid("edge"), sourceRecordId: newIds[0], targetRecordId: newIds[1], weight: 1, label: "滞留の気配" },
          { id: uid("edge"), sourceRecordId: newIds[1], targetRecordId: newIds[2], weight: 1, label: "路地の端部" },
          { id: uid("edge"), sourceRecordId: newIds[3], targetRecordId: newIds[4], weight: 1, label: "音と動線" },
        ];
        return recalculateClusters({ ...current, records, graphNodes, graphEdges });
      }, "サンプルデータを追加しました。");
    }

    function exportData() {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "record-map-data-v2.json";
      anchor.click();
      URL.revokeObjectURL(url);
    }

    async function importData(file) {
      if (!file) return;
      const text = await file.text();
      updateData(normalizeData(JSON.parse(text)), "JSONを読み込みました。");
    }

    function resetData() {
      if (!confirm("端末内に保存された全データを削除しますか？")) return;
      localStorage.removeItem(STORAGE_KEY);
      updateData({ ...initialData }, "全データを削除しました。");
    }

    return h("section", { className: "page data-page" },
      h(PageHead, {
        title: "データページ",
        body: "localStorage上の保存内容を確認し、サンプル追加、JSON書き出し、読み込みを行います。",
      }),
      h("div", { className: "data-layout" },
        h("section", { className: "panel" },
          h("h2", null, "操作"),
          h("div", { className: "toolbar vertical" },
            h("button", { type: "button", onClick: seedData }, "サンプルデータを追加"),
            h("button", { type: "button", onClick: exportData }, "JSONを書き出し"),
            h("button", { type: "button", onClick: () => fileRef.current?.click() }, "JSONを読み込み"),
            h("input", { ref: fileRef, className: "hidden", type: "file", accept: "application/json", onChange: (event) => importData(event.target.files?.[0]) }),
            h("button", { type: "button", className: "danger", onClick: resetData }, "全データ削除")
          ),
          h("dl", { className: "stats-grid" },
            h("dt", null, "記録物"), h("dd", null, `${data.records.length}件`),
            h("dt", null, "リンク線"), h("dd", null, `${data.graphEdges.length}件`),
            h("dt", null, "クラスタ"), h("dd", null, `${data.clusters.length}件`),
            h("dt", null, "保存容量"), h("dd", null, `${storageSize}KB`)
          ),
          storageSize > 3500 && h("p", { className: "warning" }, "localStorage容量が大きくなっています。写真・音声を減らすかJSONを書き出してください。")
        ),
        h("section", { className: "panel" },
          h("h2", null, "保存内容"),
          h("pre", { className: "data-preview" }, JSON.stringify(data, null, 2))
        )
      )
    );
  }

  function PageHead({ title, body }) {
    return h("div", { className: "page-head" }, h("h2", null, title), h("p", null, body));
  }

  function Segmented({ label, value, onChange, options }) {
    return h("fieldset", { className: "segmented-field" },
      h("legend", null, label),
      h("div", { className: "segmented" },
        options.map((option) => h("button", {
          key: option.value,
          type: "button",
          className: value === option.value ? "active" : "",
          onClick: () => onChange(option.value),
        }, option.label))
      )
    );
  }

  function RecordCard({ record, cluster, selected, onClick, meta }) {
    return h("article", { className: selected ? "record-card selected" : "record-card", onClick },
      h("div", { className: "record-meta" },
        h("span", null, recordIcon(record.type)),
        h("span", null, typeLabel(record.type)),
        h("span", null, formatDate(record.submittedAt))
      ),
      h("strong", null, record.title),
      record.body && h("p", null, truncate(record.body, 72)),
      record.thumbnailUrl && h("img", { src: record.thumbnailUrl, alt: "" }),
      record.type === "audio" && h("p", { className: "note" }, "音声記録"),
      h("small", null, meta || `推定精度 ±${Math.round(record.accuracy)}m`),
      cluster && h("span", { className: "cluster-chip", style: { borderColor: cluster.color } }, cluster.name)
    );
  }

  function ClusterList({ data }) {
    if (!data.clusters.length) return h("p", { className: "note" }, "クラスタがありません。");
    return h("div", { className: "cluster-list" },
      data.clusters.map((cluster) => h("article", { key: cluster.id, className: "cluster-card" },
        h("strong", null, h("span", { className: "swatch", style: { background: cluster.color } }), cluster.name),
        h("small", null, `${cluster.recordIds.length}件 / 中心 ${cluster.centerLatitude.toFixed(5)}, ${cluster.centerLongitude.toFixed(5)}`),
        h("p", null, cluster.recordIds.map((id) => data.records.find((record) => record.id === id)?.title).filter(Boolean).join(" / "))
      ))
    );
  }

  function sampleImageDataUrl() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#ebe6da"/><circle cx="210" cy="210" r="80" fill="#2f6f73" opacity=".35"/><path d="M80 320 C170 120 330 340 560 110" stroke="#242424" stroke-width="14" fill="none" opacity=".38"/><text x="42" y="72" font-family="sans-serif" font-size="36" fill="#242424">sample photo record</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
