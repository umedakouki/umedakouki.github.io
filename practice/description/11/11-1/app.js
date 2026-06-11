(() => {
  "use strict";

  const { useEffect, useMemo, useRef, useState } = React;
  const h = React.createElement;
  const STORAGE_KEY = "record-map-app-v3-cache";
  const OLD_KEYS = ["record-map-app-v2", "record-map-app-v1"];
  const MAX_AUDIO_SECONDS = 60;
  const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
  const MEDIA_BUCKET = window.RECORD_MAP_SUPABASE?.mediaBucket || "record-media";
  const CLUSTER_COLORS = ["#2f6f73", "#b4513f", "#6f5d9a", "#4f7d45", "#4b6ea9", "#8a4f73"];
  const SAMPLE_CENTER = { latitude: 35.0116, longitude: 135.7681, accuracy: 24 };

  const emptyData = {
    records: [],
    graphNodes: {},
    graphEdges: [],
    clusters: [],
    clusterMembers: [],
  };

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16)
    );
  }

  function safeParse(raw) {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getLocalSeed() {
    for (const key of [STORAGE_KEY, ...OLD_KEYS]) {
      const parsed = safeParse(localStorage.getItem(key));
      if (parsed) return normalizeData(parsed);
    }
    return { ...emptyData };
  }

  function cacheData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function hasOldLocalData() {
    return OLD_KEYS.some((key) => !!localStorage.getItem(key));
  }

  function supabaseConfig() {
    const config = window.RECORD_MAP_SUPABASE || {};
    const ready = Boolean(
      window.supabase?.createClient &&
      config.url &&
      /^https:\/\/.+\.supabase\.co/i.test(config.url) &&
      config.publishableKey &&
      !config.publishableKey.includes("YOUR_")
    );
    return { ...config, ready };
  }

  function createSupabaseClient() {
    const config = supabaseConfig();
    if (!config.ready) return null;
    return window.supabase.createClient(config.url, config.publishableKey);
  }

  const remote = {
    client: createSupabaseClient(),

    get enabled() {
      return !!this.client;
    },

    async loadAll() {
      if (!this.enabled) return getLocalSeed();
      const [recordsRes, nodesRes, edgesRes, clustersRes, membersRes] = await Promise.all([
        this.client.from("records").select("*").order("submitted_at", { ascending: true }),
        this.client.from("graph_nodes").select("*"),
        this.client.from("graph_edges").select("*").order("updated_at", { ascending: true }),
        this.client.from("clusters").select("*"),
        this.client.from("cluster_members").select("*"),
      ]);
      for (const res of [recordsRes, nodesRes, edgesRes, clustersRes, membersRes]) {
        if (res.error) throw res.error;
      }
      return normalizeData({
        records: recordsRes.data,
        graphNodes: Object.fromEntries((nodesRes.data || []).map((node) => [node.record_id, dbNodeToNode(node)])),
        graphEdges: (edgesRes.data || []).map(dbEdgeToEdge),
        clusters: (clustersRes.data || []).map((cluster) => ({
          id: cluster.id,
          name: cluster.name || "Cluster",
          centerLatitude: cluster.center_latitude,
          centerLongitude: cluster.center_longitude,
          color: cluster.color,
          metadata: cluster.metadata || {},
          recordIds: (membersRes.data || []).filter((member) => member.cluster_id === cluster.id).map((member) => member.record_id),
        })),
        clusterMembers: (membersRes.data || []).map((member) => ({
          clusterId: member.cluster_id,
          recordId: member.record_id,
          score: member.score || 1,
        })),
      });
    },

    async uploadMedia(recordId, type, blob) {
      if (!this.enabled || !blob) return null;
      const extension = blob.type?.includes("png") ? "png" : blob.type?.includes("jpeg") ? "jpg" : blob.type?.includes("webm") ? "webm" : "dat";
      const path = `${type}/${recordId}-${Date.now()}.${extension}`;
      const { error } = await this.client.storage.from(MEDIA_BUCKET).upload(path, blob, {
        upsert: true,
        contentType: blob.type || "application/octet-stream",
      });
      if (error) throw error;
      return this.client.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
    },

    async saveRecord(record, node) {
      if (!this.enabled) return;
      const { error: recordError } = await this.client.from("records").insert(dbRecord(record));
      if (recordError) throw recordError;
      const { error: nodeError } = await this.client.from("graph_nodes").upsert(dbNode(node));
      if (nodeError) throw nodeError;
    },

    async saveNode(node) {
      if (!this.enabled) return;
      const { error } = await this.client.from("graph_nodes").upsert(dbNode(node));
      if (error) throw error;
    },

    async saveEdge(edge) {
      if (!this.enabled) return;
      const { error } = await this.client.from("graph_edges").insert(dbEdge(edge));
      if (error && !String(error.message || "").includes("duplicate")) throw error;
    },

    async deleteEdge(edgeId) {
      if (!this.enabled) return;
      const { error } = await this.client.from("graph_edges").delete().eq("id", edgeId);
      if (error) throw error;
    },

    async deleteRecord(record) {
      if (!this.enabled) return;
      const { error } = await this.client.from("records").delete().eq("id", record.id);
      if (error) throw error;
      const marker = `/storage/v1/object/public/${MEDIA_BUCKET}/`;
      if (record.fileUrl?.includes(marker)) {
        const path = decodeURIComponent(record.fileUrl.split(marker)[1] || "");
        if (path) await this.client.storage.from(MEDIA_BUCKET).remove([path]);
      }
    },

    async syncClusters(data) {
      if (!this.enabled) return;
      await this.client.from("cluster_members").delete().neq("cluster_id", ZERO_UUID);
      await this.client.from("clusters").delete().neq("id", ZERO_UUID);
      if (data.clusters.length) {
        const { error } = await this.client.from("clusters").insert(data.clusters.map(dbCluster));
        if (error) throw error;
      }
      if (data.clusterMembers.length) {
        const { error } = await this.client.from("cluster_members").insert(data.clusterMembers.map(dbMember));
        if (error) throw error;
      }
    },
  };

  function normalizeData(input) {
    const records = Array.isArray(input.records) ? input.records.map((record) => ({
      id: record.id || uid(),
      type: record.type || "text",
      body: record.body || "",
      fileUrl: record.fileUrl || record.file_url || null,
      thumbnailUrl: record.thumbnailUrl || record.thumbnail_url || record.file_url || null,
      latitude: Number(record.latitude ?? SAMPLE_CENTER.latitude),
      longitude: Number(record.longitude ?? SAMPLE_CENTER.longitude),
      accuracy: Number(record.accuracy ?? 999),
      submittedAt: record.submittedAt || record.submitted_at || new Date().toISOString(),
      metadata: record.metadata || {},
    })) : [];

    const sourceNodes = input.graphNodes || input.nodes || {};
    const graphNodes = {};
    records.forEach((record, index) => {
      const node = sourceNodes[record.id] || {};
      graphNodes[record.id] = {
        recordId: record.id,
        x: Number(node.x ?? 70 + (index % 3) * 210),
        y: Number(node.y ?? 70 + Math.floor(index / 3) * 132),
        width: Number(node.width ?? 176),
        height: Number(node.height ?? 96),
      };
    });

    const graphEdges = (input.graphEdges || input.edges || []).map((edge) => ({
      id: edge.id || uid(),
      sourceRecordId: edge.sourceRecordId || edge.source_record_id || edge.source,
      targetRecordId: edge.targetRecordId || edge.target_record_id || edge.target,
      weight: Number(edge.weight || 1),
      label: edge.label || "",
    })).filter((edge) => edge.sourceRecordId && edge.targetRecordId && edge.sourceRecordId !== edge.targetRecordId);

    return recalculateClusters({
      records,
      graphNodes,
      graphEdges,
      clusters: input.clusters || [],
      clusterMembers: input.clusterMembers || input.cluster_members || [],
    });
  }

  function dbRecord(record) {
    return {
      id: record.id,
      type: record.type,
      body: record.body,
      file_url: record.fileUrl,
      thumbnail_url: record.thumbnailUrl,
      latitude: record.latitude,
      longitude: record.longitude,
      accuracy: record.accuracy,
      submitted_at: record.submittedAt,
      metadata: record.metadata || {},
    };
  }

  function dbNode(node) {
    return {
      record_id: node.recordId,
      x: node.x,
      y: node.y,
      width: node.width || 176,
      height: node.height || 96,
      updated_at: new Date().toISOString(),
    };
  }

  function dbNodeToNode(node) {
    return {
      recordId: node.record_id,
      x: node.x,
      y: node.y,
      width: node.width || 176,
      height: node.height || 96,
    };
  }

  function dbEdge(edge) {
    return {
      id: edge.id,
      source_record_id: edge.sourceRecordId,
      target_record_id: edge.targetRecordId,
      weight: edge.weight || 1,
      label: edge.label || "",
      updated_at: new Date().toISOString(),
    };
  }

  function dbEdgeToEdge(edge) {
    return {
      id: edge.id,
      sourceRecordId: edge.source_record_id,
      targetRecordId: edge.target_record_id,
      weight: edge.weight || 1,
      label: edge.label || "",
    };
  }

  function dbCluster(cluster) {
    return {
      id: cluster.id,
      name: cluster.name,
      center_latitude: cluster.centerLatitude,
      center_longitude: cluster.centerLongitude,
      color: cluster.color,
      metadata: cluster.metadata || {},
    };
  }

  function dbMember(member) {
    return {
      cluster_id: member.clusterId,
      record_id: member.recordId,
      score: member.score || 1,
    };
  }

  function recordLabel(record) {
    if (record.body) return truncate(record.body.replace(/\s+/g, " "), 22);
    if (record.type === "photo") return "写真";
    if (record.type === "audio") return "音声";
    return "記録";
  }

  function typeLabel(type) {
    return type === "photo" ? "写真" : type === "audio" ? "音声" : "テキスト";
  }

  function recordIcon(type) {
    return type === "photo" ? "写" : type === "audio" ? "音" : "文";
  }

  function truncate(text, length) {
    if (!text) return "";
    return text.length > length ? `${text.slice(0, length)}...` : text;
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
    const clusters = [];
    data.records.forEach((record) => {
      if (visited.has(record.id)) return;
      const stack = [record.id];
      const recordIds = [];
      visited.add(record.id);
      while (stack.length) {
        const current = stack.pop();
        recordIds.push(current);
        for (const next of graph.get(current) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            stack.push(next);
          }
        }
      }
      const records = recordIds.map((id) => data.records.find((item) => item.id === id)).filter(Boolean);
      const centerLatitude = records.reduce((sum, item) => sum + item.latitude, 0) / records.length;
      const centerLongitude = records.reduce((sum, item) => sum + item.longitude, 0) / records.length;
      const previous = data.clusters.find((cluster) => sameMembers(cluster.recordIds, recordIds));
      clusters.push({
        id: previous?.id || uid(),
        name: previous?.name || `Cluster ${clusters.length + 1}`,
        recordIds,
        centerLatitude,
        centerLongitude,
        color: previous?.color || CLUSTER_COLORS[clusters.length % CLUSTER_COLORS.length],
        metadata: { method: "connected-components" },
      });
    });

    const clusterMembers = clusters.flatMap((cluster) => cluster.recordIds.map((recordId) => ({
      clusterId: cluster.id,
      recordId,
      score: 1,
    })));
    return { ...data, clusters, clusterMembers };
  }

  function sameMembers(a = [], b = []) {
    return a.length === b.length && a.every((id) => b.includes(id));
  }

  function clusterFor(data, recordId) {
    return data.clusters.find((cluster) => cluster.recordIds.includes(recordId)) || null;
  }

  function colorFor(data, recordId) {
    return clusterFor(data, recordId)?.color || "#242424";
  }

  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("位置情報を取得できません。"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
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

  function blobToDataUrl(blob) {
    return fileToDataUrl(blob);
  }

  async function compressImage(file) {
    const dataUrl = await fileToDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
    const max = 1400;
    const ratio = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * ratio));
    canvas.height = Math.max(1, Math.round(img.height * ratio));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .78));
    return { blob, preview: canvas.toDataURL("image/jpeg", .78) };
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    const radius = 6371000;
    const toRad = (degree) => (degree * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function createProjector(points, width, height) {
    let minLat = Math.min(...points.map((point) => point.latitude));
    let maxLat = Math.max(...points.map((point) => point.latitude));
    let minLng = Math.min(...points.map((point) => point.longitude));
    let maxLng = Math.max(...points.map((point) => point.longitude));
    if (minLat === maxLat) { minLat -= .0004; maxLat += .0004; }
    if (minLng === maxLng) { minLng -= .0004; maxLng += .0004; }
    const pad = Math.max(28, Math.min(52, width * .08));
    return (point) => ({
      x: pad + ((point.longitude - minLng) / (maxLng - minLng)) * Math.max(1, width - pad * 2),
      y: pad + (1 - (point.latitude - minLat) / (maxLat - minLat)) * Math.max(1, height - pad * 2),
    });
  }

  function createLocalProjector(center, width, height, sideMeters = 50) {
    const half = sideMeters / 2;
    const metersPerLat = 111320;
    const metersPerLng = 111320 * Math.cos(center.latitude * Math.PI / 180);
    const pad = Math.max(24, Math.min(46, width * .07));
    return {
      contains(point) {
        const dx = (point.longitude - center.longitude) * metersPerLng;
        const dy = (point.latitude - center.latitude) * metersPerLat;
        return Math.abs(dx) <= half && Math.abs(dy) <= half;
      },
      project(point) {
        const dx = (point.longitude - center.longitude) * metersPerLng;
        const dy = (point.latitude - center.latitude) * metersPerLat;
        return {
          x: pad + ((dx + half) / sideMeters) * Math.max(1, width - pad * 2),
          y: pad + ((half - dy) / sideMeters) * Math.max(1, height - pad * 2),
        };
      },
    };
  }

  function App() {
    const [data, setData] = useState(getLocalSeed);
    const [page, setPage] = useState("submit");
    const [status, setStatus] = useState(remote.enabled ? "共有DBに接続中" : "ローカルデモ");
    const [busy, setBusy] = useState(false);
    const [selectedIds, setSelectedIds] = useState([]);
    const [activeClusterId, setActiveClusterId] = useState(null);

    useEffect(() => {
      refreshData();
    }, []);

    useEffect(() => {
      cacheData(data);
    }, [data]);

    async function refreshData() {
      setBusy(true);
      try {
        const loaded = await remote.loadAll();
        setData(loaded);
        setStatus(remote.enabled ? "共有中" : "ローカルデモ");
      } catch (error) {
        setStatus(`共有DBを読めません。ローカル表示中: ${error.message}`);
      } finally {
        setBusy(false);
      }
    }

    async function commit(nextData, message, remoteTask) {
      const normalized = normalizeData(nextData);
      setData(normalized);
      setStatus(message || (remote.enabled ? "共有中" : "ローカルデモ"));
      try {
        if (remoteTask) await remoteTask(normalized);
        cacheData(normalized);
      } catch (error) {
        setStatus(`共有DBへ保存できませんでした: ${error.message}`);
      }
      return normalized;
    }

    async function migrateLocalData() {
      if (!remote.enabled) return;
      const local = getLocalSeed();
      setBusy(true);
      try {
        for (const record of local.records) {
          await remote.saveRecord(record, local.graphNodes[record.id]);
        }
        for (const edge of local.graphEdges) {
          await remote.saveEdge(edge);
        }
        await remote.syncClusters(local);
        await refreshData();
        setStatus("端末内データを共有DBへ移行しました。");
      } catch (error) {
        setStatus(`移行できませんでした: ${error.message}`);
      } finally {
        setBusy(false);
      }
    }

    return h("div", { className: "app-shell" },
      h("header", { className: "app-header" },
        h("div", { className: "title-block" },
          h("p", { className: "kicker" }, "習作11-1"),
          h("h1", null, "記録物マッピング"),
          h("p", null, "記録する / つなぐ / 歩いて見る")
        ),
        h("nav", { className: "tabs", "aria-label": "ページ切り替え" },
          ["submit", "edit", "explore"].map((id) => h("button", {
            key: id,
            type: "button",
            className: page === id ? "tab active" : "tab",
            onClick: () => setPage(id),
          }, { submit: "送信", edit: "編集", explore: "探索" }[id]))
        ),
        h("div", { className: remote.enabled ? "connection online" : "connection local" }, busy ? "同期中" : status)
      ),
      h("main", null,
        page === "submit" && h(SubmitPage, { data, commit, setPage, refreshData, setStatus }),
        page === "edit" && h(EditPage, { data, commit, selectedIds, setSelectedIds, setStatus, migrateLocalData }),
        page === "explore" && h(ExplorePage, { data, activeClusterId, setActiveClusterId })
      )
    );
  }

  function SubmitPage({ data, commit, setPage, refreshData, setStatus }) {
    const [type, setType] = useState("text");
    const [body, setBody] = useState("");
    const [mediaBlob, setMediaBlob] = useState(null);
    const [previewUrl, setPreviewUrl] = useState("");
    const [recording, setRecording] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const [cameraActive, setCameraActive] = useState(false);
    const [manual, setManual] = useState(SAMPLE_CENTER);
    const [useManual, setUseManual] = useState(false);
    const recorderRef = useRef(null);
    const chunksRef = useRef([]);
    const streamRef = useRef(null);
    const timerRef = useRef(null);
    const cameraRef = useRef(null);
    const cameraStreamRef = useRef(null);
    const canRecord = !!(navigator.mediaDevices && window.MediaRecorder);

    useEffect(() => () => {
      stopAudioTracks();
      stopCamera();
    }, []);

    function stopAudioTracks() {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    async function choosePhoto(file) {
      if (!file) return;
      const result = await compressImage(file);
      setMediaBlob(result.blob);
      setPreviewUrl(result.preview);
    }

    async function chooseAudio(file) {
      if (!file) return;
      setMediaBlob(file);
      setPreviewUrl(await fileToDataUrl(file));
    }

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        cameraStreamRef.current = stream;
        setCameraActive(true);
        requestAnimationFrame(() => {
          if (cameraRef.current) {
            cameraRef.current.srcObject = stream;
            cameraRef.current.play().catch(() => {});
          }
        });
      } catch (error) {
        setStatus(`カメラを起動できませんでした: ${error.message}`);
      }
    }

    function stopCamera() {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraActive(false);
    }

    async function capturePhoto() {
      const video = cameraRef.current;
      if (!video?.videoWidth) return;
      const canvas = document.createElement("canvas");
      const max = 1600;
      const sourceSize = Math.min(video.videoWidth, video.videoHeight);
      const sourceX = (video.videoWidth - sourceSize) / 2;
      const sourceY = (video.videoHeight - sourceSize) / 2;
      const outputSize = Math.min(max, sourceSize);
      canvas.width = outputSize;
      canvas.height = outputSize;
      canvas.getContext("2d").drawImage(video, sourceX, sourceY, sourceSize, sourceSize, 0, 0, outputSize, outputSize);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .84));
      setMediaBlob(blob);
      setPreviewUrl(canvas.toDataURL("image/jpeg", .84));
      stopCamera();
    }

    async function toggleRecording() {
      if (recording) {
        recorderRef.current?.stop();
        return;
      }
      if (!canRecord) {
        setStatus("このブラウザでは録音できないため、音声ファイルを選んでください。");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            sampleRate: { ideal: 48000 },
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false },
          },
        });
        streamRef.current = stream;
        chunksRef.current = [];
        const preferredMime = [
          "audio/webm;codecs=opus",
          "audio/mp4;codecs=mp4a.40.2",
          "audio/webm",
        ].find((mime) => MediaRecorder.isTypeSupported(mime));
        const recorder = new MediaRecorder(stream, {
          ...(preferredMime ? { mimeType: preferredMime } : {}),
          audioBitsPerSecond: 128000,
        });
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          setMediaBlob(blob);
          setPreviewUrl(await blobToDataUrl(blob));
          setRecording(false);
          stopAudioTracks();
        };
        recorder.start();
        setSeconds(0);
        setRecording(true);
        timerRef.current = setInterval(() => {
          setSeconds((current) => {
            const next = current + 1;
            if (next >= MAX_AUDIO_SECONDS) recorder.stop();
            return Math.min(next, MAX_AUDIO_SECONDS);
          });
        }, 1000);
      } catch (error) {
        setStatus(`録音を開始できませんでした: ${error.message}`);
      }
    }

    async function submit(event) {
      event.preventDefault();
      const text = body.trim();
      if (type === "text" && !text) {
        setStatus("テキストを入力してください。");
        return;
      }
      if ((type === "photo" || type === "audio") && !mediaBlob) {
        setStatus(type === "photo" ? "写真を選んでください。" : "音声を録音または選択してください。");
        return;
      }
      let location;
      try {
        if (useManual) {
          location = {
            latitude: Number(manual.latitude),
            longitude: Number(manual.longitude),
            accuracy: Number(manual.accuracy || 999),
          };
        } else {
          const pos = await getCurrentPosition();
          location = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
        }
      } catch (error) {
        setStatus(`位置情報を取得できませんでした。詳細から手入力できます。(${error.message})`);
        return;
      }

      const id = uid();
      let fileUrl = null;
      let thumbnailUrl = null;
      try {
        if (mediaBlob && remote.enabled) {
          fileUrl = await remote.uploadMedia(id, type, mediaBlob);
          thumbnailUrl = type === "photo" ? fileUrl : null;
        } else if (mediaBlob) {
          fileUrl = previewUrl || await blobToDataUrl(mediaBlob);
          thumbnailUrl = type === "photo" ? fileUrl : null;
        }
      } catch (error) {
        setStatus(`メディアを保存できませんでした: ${error.message}`);
        return;
      }

      const record = {
        id,
        type,
        body: type === "text" ? text : "",
        fileUrl,
        thumbnailUrl,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        submittedAt: new Date().toISOString(),
        metadata: { source: remote.enabled ? "supabase" : "local" },
      };
      const node = {
        recordId: id,
        x: 64 + (data.records.length % 3) * 196,
        y: 64 + Math.floor(data.records.length / 3) * 120,
        width: 176,
        height: 96,
      };
      const next = normalizeData({
        ...data,
        records: [...data.records, record],
        graphNodes: { ...data.graphNodes, [id]: node },
      });
      await commit(next, "保存しました。", async () => {
        await remote.saveRecord(record, node);
        await remote.syncClusters(next);
      });
      setBody("");
      setMediaBlob(null);
      setPreviewUrl("");
      await refreshData();
      setPage("edit");
    }

    return h("section", { className: "page submit-page" },
      h("form", { className: "panel simple-form", onSubmit: submit },
        h(Segmented, {
          value: type,
          onChange: (next) => {
            setType(next);
            setBody("");
            setMediaBlob(null);
            setPreviewUrl("");
          },
          options: [
            { value: "text", label: "テキスト" },
            { value: "photo", label: "写真" },
            { value: "audio", label: "音声" },
          ],
        }),
        type === "text" && h("textarea", {
          className: "main-input",
          value: body,
          onChange: (event) => setBody(event.target.value),
          rows: 8,
          placeholder: "ここで起きていること、見えたもの、聞こえたもの",
        }),
        type === "photo" && h("div", { className: "media-field" },
          cameraActive
            ? h("div", { className: "camera-box" },
              h("video", { ref: cameraRef, className: "camera-preview", playsInline: true, muted: true }),
              h("div", { className: "camera-actions" },
                h("button", { type: "button", className: "primary", onClick: capturePhoto }, "撮影"),
                h("button", { type: "button", onClick: stopCamera }, "閉じる")
              )
            )
            : h("button", { type: "button", className: "record-button", onClick: startCamera }, "撮影"),
          h("details", { className: "subtle-details" },
            h("summary", null, "ファイルから選ぶ"),
            h("input", { type: "file", accept: "image/*", capture: "environment", onChange: (event) => choosePhoto(event.target.files?.[0]) })
          ),
          previewUrl && h("img", { className: "media-preview", src: previewUrl, alt: "写真プレビュー" })
        ),
        type === "audio" && h("div", { className: "media-field" },
          h("button", { type: "button", className: recording ? "record-button active" : "record-button", onClick: toggleRecording },
            recording ? `停止 ${seconds}s` : "録音"
          ),
          !canRecord && h("label", { className: "big-picker" }, "音声ファイルを選ぶ",
            h("input", { type: "file", accept: "audio/*", onChange: (event) => chooseAudio(event.target.files?.[0]) })
          ),
          canRecord && h("details", { className: "subtle-details" },
            h("summary", null, "ファイルから選ぶ"),
            h("input", { type: "file", accept: "audio/*", onChange: (event) => chooseAudio(event.target.files?.[0]) })
          ),
          previewUrl && h("audio", { className: "audio-preview", src: previewUrl, controls: true })
        ),
        h("details", { className: "subtle-details" },
          h("summary", null, "詳細"),
          h("label", { className: "check-row" },
            h("input", { type: "checkbox", checked: useManual, onChange: (event) => setUseManual(event.target.checked) }),
            "位置を手入力する"
          ),
          useManual && h("div", { className: "manual-grid" },
            h("input", { inputMode: "decimal", value: manual.latitude, onChange: (event) => setManual({ ...manual, latitude: event.target.value }), "aria-label": "緯度" }),
            h("input", { inputMode: "decimal", value: manual.longitude, onChange: (event) => setManual({ ...manual, longitude: event.target.value }), "aria-label": "経度" }),
            h("input", { inputMode: "numeric", value: manual.accuracy, onChange: (event) => setManual({ ...manual, accuracy: event.target.value }), "aria-label": "推定精度" })
          ),
          h("button", { type: "button", onClick: refreshData }, "再読み込み")
        ),
        h("button", { className: "primary submit-button", type: "submit" }, "送信")
      )
    );
  }

  function EditPage({ data, commit, selectedIds, setSelectedIds, setStatus, migrateLocalData }) {
    const [dragging, setDragging] = useState(null);
    const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
    const pointersRef = useRef(new Map());
    const gestureRef = useRef(null);

    function toggle(id) {
      setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-2));
    }

    async function connect() {
      if (selectedIds.length !== 2) return;
      const [sourceRecordId, targetRecordId] = selectedIds;
      const exists = data.graphEdges.some((edge) =>
        (edge.sourceRecordId === sourceRecordId && edge.targetRecordId === targetRecordId) ||
        (edge.sourceRecordId === targetRecordId && edge.targetRecordId === sourceRecordId)
      );
      if (exists) {
        setStatus("すでにつながっています。");
        return;
      }
      const edge = { id: uid(), sourceRecordId, targetRecordId, weight: 1, label: "" };
      const next = recalculateClusters({ ...data, graphEdges: [...data.graphEdges, edge] });
      await commit(next, "つなぎました。", async (saved) => {
        await remote.saveEdge(edge);
        await remote.syncClusters(saved);
      });
    }

    async function deleteEdge(id) {
      if (!confirm("このつながりを削除しますか？")) return;
      const next = recalculateClusters({ ...data, graphEdges: data.graphEdges.filter((edge) => edge.id !== id) });
      await commit(next, "線を削除しました。", async (saved) => {
        await remote.deleteEdge(id);
        await remote.syncClusters(saved);
      });
    }

    async function deleteRecord(record) {
      if (!confirm(`「${recordLabel(record)}」を削除しますか？\nこの記録につながる線も削除されます。`)) return;
      const graphNodes = { ...data.graphNodes };
      delete graphNodes[record.id];
      const next = recalculateClusters({
        ...data,
        records: data.records.filter((item) => item.id !== record.id),
        graphNodes,
        graphEdges: data.graphEdges.filter((edge) => edge.sourceRecordId !== record.id && edge.targetRecordId !== record.id),
      });
      setSelectedIds((current) => current.filter((id) => id !== record.id));
      await commit(next, "記録を削除しました。", async (saved) => {
        await remote.deleteRecord(record);
        await remote.syncClusters(saved);
      });
    }

    function startDrag(event, id) {
      event.stopPropagation();
      const node = data.graphNodes[id];
      if (!node) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging({ id, sx: event.clientX, sy: event.clientY, x: node.x, y: node.y });
      setSelectedIds((current) => current.includes(id) ? current : [...current, id].slice(-2));
    }

    async function endDrag() {
      if (!dragging) return;
      const node = data.graphNodes[dragging.id];
      setDragging(null);
      await remote.saveNode(node);
    }

    function moveDrag(event) {
      if (!dragging) return;
      const dx = (event.clientX - dragging.sx) / view.scale;
      const dy = (event.clientY - dragging.sy) / view.scale;
      const node = data.graphNodes[dragging.id];
      commit({
        ...data,
        graphNodes: {
          ...data.graphNodes,
          [dragging.id]: { ...node, x: Math.max(0, dragging.x + dx), y: Math.max(0, dragging.y + dy) },
        },
      });
    }

    function clampScale(value) {
      return Math.min(2.5, Math.max(.3, value));
    }

    function zoomAt(clientX, clientY, nextScale, element) {
      const rect = element.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      setView((current) => {
        const scale = clampScale(nextScale);
        const worldX = (sx - current.x) / current.scale;
        const worldY = (sy - current.y) / current.scale;
        return { x: sx - worldX * scale, y: sy - worldY * scale, scale };
      });
    }

    function canvasPointerDown(event) {
      if (event.target.closest?.(".record-node")) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointersRef.current.values()];
      if (points.length === 1) {
        gestureRef.current = { type: "pan", x: points[0].x, y: points[0].y, view };
      } else if (points.length === 2) {
        const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        gestureRef.current = {
          type: "pinch",
          distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
          center,
          view,
        };
      }
    }

    function canvasPointerMove(event) {
      if (!pointersRef.current.has(event.pointerId)) return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointersRef.current.values()];
      const gesture = gestureRef.current;
      if (points.length === 2) {
        const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const base = gesture?.type === "pinch" ? gesture : { distance, center, view };
        const scale = clampScale(base.view.scale * distance / Math.max(1, base.distance));
        const rect = event.currentTarget.getBoundingClientRect();
        const baseX = base.center.x - rect.left;
        const baseY = base.center.y - rect.top;
        const worldX = (baseX - base.view.x) / base.view.scale;
        const worldY = (baseY - base.view.y) / base.view.scale;
        const currentX = center.x - rect.left;
        const currentY = center.y - rect.top;
        setView({ x: currentX - worldX * scale, y: currentY - worldY * scale, scale });
      } else if (points.length === 1 && gesture?.type === "pan") {
        setView({ ...gesture.view, x: gesture.view.x + points[0].x - gesture.x, y: gesture.view.y + points[0].y - gesture.y });
      }
    }

    function canvasPointerUp(event) {
      pointersRef.current.delete(event.pointerId);
      const points = [...pointersRef.current.values()];
      if (points.length === 1) gestureRef.current = { type: "pan", x: points[0].x, y: points[0].y, view };
      else gestureRef.current = null;
    }

    async function nudge(dx, dy) {
      if (!selectedIds.length) return;
      const graphNodes = { ...data.graphNodes };
      selectedIds.forEach((id) => {
        const node = graphNodes[id];
        graphNodes[id] = { ...node, x: Math.max(0, node.x + dx), y: Math.max(0, node.y + dy) };
      });
      const next = { ...data, graphNodes };
      await commit(next);
      await Promise.all(selectedIds.map((id) => remote.saveNode(graphNodes[id])));
    }

    const selected = selectedIds.map((id) => data.records.find((record) => record.id === id)).filter(Boolean);
    const selectedEdge = selectedIds.length === 2 ? data.graphEdges.find((edge) =>
      (edge.sourceRecordId === selectedIds[0] && edge.targetRecordId === selectedIds[1]) ||
      (edge.sourceRecordId === selectedIds[1] && edge.targetRecordId === selectedIds[0])
    ) : null;

    return h("section", { className: "page edit-page" },
      h("div", { className: "edit-layout simplified" },
        h("section", { className: "panel canvas-panel" },
          h("div", { className: "canvas-toolbar" },
            h("span", null, selected.length ? `${selected.length}件選択中 / ${Math.round(view.scale * 100)}%` : `ピンチで拡大縮小 / ${Math.round(view.scale * 100)}%`),
            selected.length === 2 && (selectedEdge
              ? h("button", { type: "button", className: "danger small-action", onClick: () => deleteEdge(selectedEdge.id) }, "つながりを削除")
              : h("button", { type: "button", className: "primary small-action", onClick: connect }, "つなぐ"))
          ),
          h("div", {
            className: "edit-canvas",
            onPointerDown: canvasPointerDown,
            onPointerMove: (event) => { moveDrag(event); canvasPointerMove(event); },
            onPointerUp: (event) => { endDrag(); canvasPointerUp(event); },
            onPointerCancel: (event) => { endDrag(); canvasPointerUp(event); },
            onWheel: (event) => {
              event.preventDefault();
              zoomAt(event.clientX, event.clientY, view.scale * (event.deltaY < 0 ? 1.12 : .89), event.currentTarget);
            },
          },
            h("div", { className: "edit-world", style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } },
            h("svg", { className: "edge-layer", viewBox: "0 0 2400 1600", preserveAspectRatio: "none" },
              data.graphEdges.map((edge) => {
                const a = data.graphNodes[edge.sourceRecordId];
                const b = data.graphNodes[edge.targetRecordId];
                if (!a || !b) return null;
                return h("line", {
                  key: edge.id,
                  x1: a.x + 88,
                  y1: a.y + 48,
                  x2: b.x + 88,
                  y2: b.y + 48,
                  stroke: colorFor(data, edge.sourceRecordId),
                  strokeWidth: 2.2,
                });
              })
            ),
            data.records.map((record) => {
              const node = data.graphNodes[record.id];
              return h("div", {
                key: record.id,
                role: "button",
                tabIndex: 0,
                className: selectedIds.includes(record.id) ? "record-node selected" : "record-node",
                style: { left: `${node.x}px`, top: `${node.y}px`, borderColor: colorFor(data, record.id) },
                onPointerDown: (event) => startDrag(event, record.id),
                onKeyDown: (event) => {
                  if (event.key === "Enter" || event.key === " ") toggle(record.id);
                },
              },
                h("span", { className: "node-type" }, typeLabel(record.type)),
                h("strong", null, recordLabel(record)),
                record.thumbnailUrl && h("img", { src: record.thumbnailUrl, alt: "" }),
                record.type === "audio" && record.fileUrl && h(AudioPlayButton, { src: record.fileUrl })
              );
            })
            )
          )
        ),
        h("aside", { className: `panel side-panel detail-panel ${selected.length ? "is-open" : ""}` },
          h("div", { className: "popup-heading" },
            h("h2", null, "選択中"),
            selected.length > 0 && h("button", { type: "button", className: "popup-close", onClick: () => setSelectedIds([]), "aria-label": "閉じる" }, "×")
          ),
          selected.length ? selected.map((record) => h("div", { className: "selected-record", key: record.id },
            h(RecordDetail, { record, cluster: clusterFor(data, record.id), compactAudio: true }),
            h("button", { type: "button", className: "danger delete-record", onClick: () => deleteRecord(record) }, "この記録を削除")
          )) : h("p", { className: "note" }, "記録物を選んでください。"),
          remote.enabled && hasOldLocalData() && h("details", { className: "subtle-details" },
            h("summary", null, "詳細"),
            h("button", { type: "button", onClick: migrateLocalData }, "端末内データを共有DBへ移行")
          )
        )
      )
    );
  }

  function ExplorePage({ data, activeClusterId, setActiveClusterId }) {
    const [location, setLocation] = useState(null);
    const [watching, setWatching] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const [mapSize, setMapSize] = useState({ width: 720, height: 520 });
    const mapRef = useRef(null);
    const watchRef = useRef(null);
    const selectedOriginRef = useRef(null);

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

    function toggleWatch() {
      if (watching) {
        stopWatch();
        return;
      }
      if (!("geolocation" in navigator)) return;
      watchRef.current = navigator.geolocation.watchPosition((pos) => {
        const nextLocation = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        if (selectedOriginRef.current && distanceMeters(
          selectedOriginRef.current.latitude,
          selectedOriginRef.current.longitude,
          nextLocation.latitude,
          nextLocation.longitude
        ) > 4) {
          selectedOriginRef.current = null;
          setSelectedId(null);
        }
        setLocation(nextLocation);
      }, () => setWatching(false), {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 12000,
      });
      setWatching(true);
    }

    function stopWatch() {
      if (watchRef.current != null && "geolocation" in navigator) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      setWatching(false);
    }

    const localMap = location ? createLocalProjector(location, mapSize.width, mapSize.height, 50) : null;
    const visibleRecords = localMap ? data.records.filter((record) => localMap.contains(record)) : [];
    const selected = visibleRecords.find((record) => record.id === selectedId) || null;
    const selectedCluster = selected ? clusterFor(data, selected.id) : data.clusters.find((cluster) => cluster.id === activeClusterId);
    const activeRecordIds = selectedCluster?.recordIds || [];
    const clusterRecords = selectedCluster ? data.records.filter((record) => record.id !== selected?.id && activeRecordIds.includes(record.id)) : [];

    function closeRecord() {
      selectedOriginRef.current = null;
      setSelectedId(null);
    }

    return h("section", { className: "page explore-page" },
      h("section", { className: "panel map-panel solo-map" },
        h("div", { className: "map-toolbar simple" },
          h("button", { type: "button", className: watching ? "primary" : "", onClick: toggleWatch }, watching ? "追跡中" : "現在地"),
          h("span", null, location ? `50m四方 / ±${Math.round(location.accuracy)}m` : "現在地を取得すると周囲が見えます")
        ),
        h("div", { className: "abstract-map", ref: mapRef },
          visibleRecords.map((record) => {
            const p = localMap.project(record);
            const clusterActive = activeRecordIds.includes(record.id);
            return h("button", {
              key: record.id,
              type: "button",
              className: `map-marker ${clusterActive ? "cluster-active" : ""} ${selectedId === record.id ? "selected" : ""}`,
              style: { left: `${p.x}px`, top: `${p.y}px`, borderColor: colorFor(data, record.id), background: clusterActive ? colorFor(data, record.id) : "#fffdfa" },
              onClick: () => {
                selectedOriginRef.current = location;
                setSelectedId(record.id);
                setActiveClusterId(clusterFor(data, record.id)?.id || null);
              },
            }, recordIcon(record.type));
          }),
          location && h("div", { className: "user-marker", style: { left: `${localMap.project(location).x}px`, top: `${localMap.project(location).y}px` } }),
          !location && h("div", { className: "map-empty" }, "現在地を押してください"),
          location && !visibleRecords.length && h("div", { className: "map-empty" }, "この50m四方には記録がありません")
        )
      ),
      selected && h("button", { type: "button", className: "popup-backdrop", onClick: closeRecord, "aria-label": "記録を閉じる" }),
      selected && h("aside", { className: "panel record-popup" },
        h("div", { className: "popup-heading" },
          h("span", { className: "note" }, "記録"),
          h("button", { type: "button", className: "popup-close", onClick: closeRecord, "aria-label": "閉じる" }, "×")
        ),
        h(RecordDetail, { record: selected, cluster: selectedCluster }),
        clusterRecords.length > 0 && h("section", { className: "cluster-companions" },
          h("h3", null, "同じまとまりの記録"),
          h("div", { className: "cluster-record-grid" },
            clusterRecords.map((record) => h("article", { className: "cluster-record", key: record.id },
              h("span", { className: "node-type" }, typeLabel(record.type)),
              h("strong", null, recordLabel(record)),
              record.body && h("p", null, record.body),
              record.type === "photo" && record.fileUrl && h("img", { src: record.fileUrl, alt: "" }),
              record.type === "audio" && record.fileUrl && h(AudioPlayButton, { src: record.fileUrl })
            ))
          )
        )
      )
    );
  }

  function RecordCard({ record, cluster, selected, onClick }) {
    return h("button", { type: "button", className: selected ? "record-card selected" : "record-card", onClick },
      h("span", { className: "record-kind" }, recordIcon(record.type)),
      h("strong", null, recordLabel(record)),
      cluster && h("small", null, cluster.name),
      record.type === "audio" && record.fileUrl && h("audio", { src: record.fileUrl, controls: true, onClick: (event) => event.stopPropagation() })
    );
  }

  function AudioPlayButton({ src }) {
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);

    async function toggleAudio(event) {
      event.stopPropagation();
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        try {
          await audio.play();
          setPlaying(true);
        } catch (_) {
          setPlaying(false);
        }
      } else {
        audio.pause();
        setPlaying(false);
      }
    }

    return h("span", { className: "audio-play-wrap", onPointerDown: (event) => event.stopPropagation() },
      h("audio", { ref: audioRef, src, preload: "metadata", onEnded: () => setPlaying(false) }),
      h("button", { type: "button", className: "audio-play-button", onClick: toggleAudio }, playing ? "停止" : "再生")
    );
  }

  function RecordDetail({ record, cluster, compactAudio = false }) {
    return h("article", { className: "record-detail" },
      h("div", { className: "record-meta" },
        h("span", null, typeLabel(record.type)),
        cluster && h("span", null, cluster.name)
      ),
      h("h3", null, recordLabel(record)),
      record.body && h("p", null, record.body),
      record.type === "photo" && record.fileUrl && h("img", { src: record.fileUrl, alt: "" }),
      record.type === "audio" && record.fileUrl && (compactAudio
        ? h(AudioPlayButton, { src: record.fileUrl })
        : h("audio", { src: record.fileUrl, controls: true })),
      h("small", null, `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)} / ±${Math.round(record.accuracy)}m`)
    );
  }

  function Segmented({ value, onChange, options }) {
    return h("div", { className: "segmented" },
      options.map((option) => h("button", {
        key: option.value,
        type: "button",
        className: value === option.value ? "active" : "",
        onClick: () => onChange(option.value),
      }, option.label))
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
