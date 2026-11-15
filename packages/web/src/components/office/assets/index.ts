// Map id → URL đã import (Vite gắn hash, đúng với base "./"). Chỉ chunk lười của Office tham chiếu các file này.
// File .webp do brainstorm/newUI/tools/build_office_assets.py sinh; thêm món mới thì thêm cả ở script.
import type { FurnitureSprite } from "../model/layout";
import type { SkinIndex } from "../model/skin";
import background from "./background.webp";
import arcadeCabinet from "./furniture/arcade_cabinet.webp";
import bookshelfLounge from "./furniture/bookshelf_lounge.webp";
import coffeeStation from "./furniture/coffee_station.webp";
import dashboardMonitor from "./furniture/dashboard_monitor.webp";
import floorLamp from "./furniture/floor_lamp.webp";
import flowBoard from "./furniture/flow_board.webp";
import flowerBox from "./furniture/flower_box.webp";
import flowerPlanter from "./furniture/flower_planter.webp";
import guitar from "./furniture/guitar.webp";
import hologramTable from "./furniture/hologram_table.webp";
import kanbanBoard from "./furniture/kanban_board.webp";
import palmPlanter from "./furniture/palm_planter.webp";
import planningTable from "./furniture/planning_table.webp";
import pottedPalm from "./furniture/potted_palm.webp";
import rechargePod from "./furniture/recharge_pod.webp";
import robotVacuum from "./furniture/robot_vacuum.webp";
import serverRack from "./furniture/server_rack.webp";
import smallPlanter from "./furniture/small_planter.webp";
import sofa from "./furniture/sofa.webp";
import utilityShelf from "./furniture/utility_shelf.webp";
import vendingMachine from "./furniture/vending_machine.webp";
import waterDispenser from "./furniture/water_dispenser.webp";
import workstationAnalytics from "./furniture/workstation_analytics.webp";
import workstationBasic from "./furniture/workstation_basic.webp";
import workstationDual from "./furniture/workstation_dual.webp";
import workstationManager from "./furniture/workstation_manager.webp";
import orchestrator from "./orchestrator.webp";
import planner from "./planner.webp";
import worker1 from "./worker1.webp";
import worker2 from "./worker2.webp";
import worker3 from "./worker3.webp";
import worker4 from "./worker4.webp";
import worker5 from "./worker5.webp";

export const BACKGROUND_URL: string = background;

export const WORKER_SHEET_URLS: Record<SkinIndex, string> = [worker1, worker2, worker3, worker4, worker5];

export const AGENT_URLS = { planner, orchestrator } as const;

export const FURNITURE_URLS: Record<FurnitureSprite, string> = {
  workstation_basic: workstationBasic,
  workstation_dual: workstationDual,
  workstation_analytics: workstationAnalytics,
  workstation_manager: workstationManager,
  sofa,
  vending_machine: vendingMachine,
  water_dispenser: waterDispenser,
  arcade_cabinet: arcadeCabinet,
  coffee_station: coffeeStation,
  bookshelf_lounge: bookshelfLounge,
  floor_lamp: floorLamp,
  guitar,
  recharge_pod: rechargePod,
  server_rack: serverRack,
  utility_shelf: utilityShelf,
  kanban_board: kanbanBoard,
  flow_board: flowBoard,
  planning_table: planningTable,
  hologram_table: hologramTable,
  dashboard_monitor: dashboardMonitor,
  potted_palm: pottedPalm,
  palm_planter: palmPlanter,
  flower_box: flowerBox,
  small_planter: smallPlanter,
  flower_planter: flowerPlanter,
  robot_vacuum: robotVacuum,
};
