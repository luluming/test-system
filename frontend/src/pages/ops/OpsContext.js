import { createContext, useContext } from "react";

/* 行业工作台共享上下文：外壳持有状态，视图组件通过 useOps() 消费。 */
export const OpsContext = createContext(null);
export function useOps() {
  return useContext(OpsContext);
}
