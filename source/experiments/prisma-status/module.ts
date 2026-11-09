import { module } from "@prisma/composer";
import statusService from "./src/service.ts";

export default module("nexora-status", ({ provision }) => {
  provision(statusService);
});