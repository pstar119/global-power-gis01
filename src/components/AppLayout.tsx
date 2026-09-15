import { useEffect, useRef, useState } from "react";
import Sidebar, { MENU_ITEMS, type MenuKey } from "./Sidebar";
import TopBar from "./TopBar";
import MapPage, { type MapFlyTo } from "../pages/MapPage";
import StatsPage from "../pages/StatsPage";
import SettingsPage from "../pages/SettingsPage";
import WelcomeWizard, { WIZARD_FLAG_KEY } from "./WelcomeWizard";
import { usePackDownloads } from "../hooks/usePackDownloads";
import type {
  ConversationTurn,
  MapCommand,
  ParsedQuery,
  PlantFocus,
  QueryContext,
} from "../lib/nlq";
import { MAX_STORED_TURNS } from "../lib/nlq";
import styles from "./AppLayout.module.css";

const APP_TITLE = "Global Power GIS";

/** 取某个菜单项固定的 hint（页面标题），与当前激活项无关 */
const hintOf = (key: MenuKey) =>
  MENU_ITEMS.find((item) => item.key === key)?.hint ?? "";

function AppLayout() {
  const [activeKey, setActiveKey] = useState<MenuKey>("map");

  /**
   * 跨页面向地图下达的指令。
   *
   * ⚠️ 刻意只用 useState 提升到这里，不引入 Zustand 等状态库：
   *    跨页数据只有「一个可选命令」这一种，为它加一层依赖不划算。
   * ⚠️ id 自增：MapPage 靠它去重，避免同一个命令被重复执行。
   */
  const [mapCommand, setMapCommand] = useState<MapCommand | null>(null);
  const commandSeq = useRef(0);

  /**
   * 阶段48：把地图镜头移到某个区域（首次启动向导完成后用）。
   *
   * ‼️ 刻意**不复用** `mapCommand` 通道：那条通道的载荷是 `ParsedQuery`，
   *    它是**自然语言查询的契约**（intent/fuel/country/limit）。
   *    把「飞到一个 bbox」塞进去会污染 AI 那层的语义，还得改 nlq.ts 的类型与校验。
   *    单独一条只有相机信息的通道反而更干净、互不影响。
   */
  const [flyTo, setFlyTo] = useState<MapFlyTo | null>(null);
  const flySeq = useRef(0);

  /**
   * 阶段48：数据包探测与首次启动向导。
   *
   * ‼️ hook 放在这里而不是向导内部：向导是**条件渲染**的（未装包才弹），
   *    若由它自己持有 hook，弹之前就无法判断「到底该不该弹」。
   *    放在 AppLayout 也保证全应用只一份状态（与设置页那份互不影响，不同时可见）。
   */
  const packApi = usePackDownloads();
  const [wizardOpen, setWizardOpen] = useState(false);
  /** 已走过一次向导（完成或跳过）就不再自动弹，否则每启动一次弹一次 */
  const [wizardSeen, setWizardSeen] = useState(
    () => localStorage.getItem(WIZARD_FLAG_KEY) === "1",
  );

  useEffect(() => {
    if (wizardSeen || wizardOpen) return;
    // 清单没读到 / 不是 Tauri 环境 → 一律不弹。
    // 宁可没有引导，也不能因为一个探测失败让用户卡在门口。
    if (!packApi.manifest || !packApi.bridgeOk) return;
    // ⚠️ 探测还没回来时 statuses 是空对象 —— 此时**不能**推断「一个包都没装」，
    //    那样会在每次启动时闪一下向导。
    if (Object.keys(packApi.statuses).length === 0) return;
    if (Object.values(packApi.statuses).some((s) => s.exists)) return;
    setWizardOpen(true);
  }, [packApi.manifest, packApi.statuses, packApi.bridgeOk, wizardSeen, wizardOpen]);

  /** 结束向导：写标记、切回地图页、并把镜头移到已就绪区域 */
  const handleWizardFinish = (bbox: [number, number, number, number] | null) => {
    localStorage.setItem(WIZARD_FLAG_KEY, "1");
    setWizardSeen(true);
    setWizardOpen(false);
    setActiveKey("map");
    if (bbox) {
      flySeq.current += 1;
      setFlyTo({ bbox, seq: flySeq.current });
    }
  };

  /**
   * 阶段31：地图视野上下文（供 AI 解析「当前视野」类问题）。
   *
   * ⚠️ 用 **ref** 而不是 state：`moveend` 在拖拽时每秒触发多次，走 state 会让
   *    整棵应用（含挂着 3.5 万个点与聚合索引的地图页）在最频繁交互的时刻反复重渲染。
   *    MapPage 是**唯一写入者**，其余读方在提问瞬间读取权威值。
   */
  const viewportRef = useRef<QueryContext | null>(null);

  /**
   * 「上次查询结果已过期」信号。地图视野移动后 +1。
   *
   * 两个结果展示处（设置页 AI 面板、地图页查询框）据此清空，否则会出现
   * 「地图已经飘到别处、表格还停在那块区域」的误导组合。
   */
  const [staleSeq, setStaleSeq] = useState(0);
  const handleResultsStale = () => {
    setStaleSeq((n) => n + 1);
    // 阶段32：结果都清空了，选中行不能还亮着
    setFocusedPlant(null);
  };

  /**
   * 阶段32：当前被聚焦的那一座电厂（点击结果表格行）。
   *
   * ⚠️ 刻意只用 useState，不引入 Zustand / Redux：跨页共享的状态只有
   *    「一个可选命令 + 一个可选焦点」，为它加一层依赖不划算。
   * ⚠️ 它只负责**标记表格里的选中行**；真正飞过去靠同一条 MapCommand 通道。
   */
  const [focusedPlant, setFocusedPlant] = useState<PlantFocus | null>(null);

  /**
   * 阶段33：共享的多轮对话记忆。
   *
   * ⚠️ 放这里而不是各页面自己存：地图页工作台与设置页面板是两个**兄弟组件**，
   *    各存一份会变成两段互不可见的对话（在一边追问，另一边完全不知道）。
   * ⚠️ 仍然只用 useState + Props，**不引入任何状态库**。
   */
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const handleQueryDone = (turn: ConversationTurn) =>
    setHistory((prev) => [...prev, turn].slice(-MAX_STORED_TURNS));

  const handleFocusPlant = (plant: PlantFocus) => {
    commandSeq.current += 1;
    setMapCommand({
      intent: "plant_list",
      id: commandSeq.current,
      focus: plant,
    });
    setFocusedPlant(plant);
    setActiveKey("map");
  };

  const handleViewOnMap = (query: ParsedQuery) => {
    commandSeq.current += 1;
    setMapCommand({ ...query, id: commandSeq.current });
    setActiveKey("map");
  };

  /**
   * 只清空地图高亮，不切页、不动视角。
   *
   * ⚠️ intent 在这里是必填字段但**不会被使用** —— MapPage 的 applyCommand
   *    看到 clearOnly 就会提前 return。填 global_stats 只是为满足类型。
   */
  const handleClearMap = () => {
    commandSeq.current += 1;
    setMapCommand({
      intent: "global_stats",
      id: commandSeq.current,
      clearOnly: true,
    });
    // 新查询开始 → 上一次的聚焦已经失效
    setFocusedPlant(null);
  };

  const activeItem =
    MENU_ITEMS.find((item) => item.key === activeKey) ?? MENU_ITEMS[0];

  return (
    <div className={styles.shell}>
      <Sidebar
        items={MENU_ITEMS}
        activeKey={activeKey}
        onSelect={setActiveKey}
      />

      <div className={styles.main}>
        <TopBar title={APP_TITLE} />

        <section className={styles.content} aria-label={activeItem.label}>
          {/* ⚠️ 三个页面**同时挂载**，只切换可见性而非卸载。
              这样 MapLibre 实例、3.5 万个点与聚合索引只创建一次，
              切页不再重建 —— 既让「在地图上查看」能瞬间响应，
              也避免了反复 create/destroy 地图带来的泄漏风险。
              代价是三页常驻内存，而地图那部分本来就只占一份，增量很小。 */}
          <div className={styles.pageSlot} hidden={activeKey !== "map"}>
            <MapPage
              command={mapCommand}
              flyTo={flyTo}
              viewportRef={viewportRef}
              onResultsStale={handleResultsStale}
              onViewOnMap={handleViewOnMap}
              onClearMap={handleClearMap}
              onFocusPlant={handleFocusPlant}
              focusedPlant={focusedPlant}
              history={history}
              onQueryDone={handleQueryDone}
            />
          </div>

          <div className={styles.pageSlot} hidden={activeKey !== "stats"}>
            <StatsPage hint={hintOf("stats")} />
          </div>

          <div className={styles.pageSlot} hidden={activeKey !== "settings"}>
            <SettingsPage
              hint={hintOf("settings")}
              onViewOnMap={handleViewOnMap}
              onClearMap={handleClearMap}
              viewportRef={viewportRef}
              staleSeq={staleSeq}
              onFocusPlant={handleFocusPlant}
              focusedPlant={focusedPlant}
              history={history}
              onQueryDone={handleQueryDone}
            />
          </div>
        </section>
      </div>

      {/* 阶段48：首次启动向导。放在最外层（fixed 遮罩），盖住侧边栏与所有面板 */}
      {wizardOpen && (
        <WelcomeWizard api={packApi} onFinish={handleWizardFinish} />
      )}
    </div>
  );
}

export default AppLayout;
