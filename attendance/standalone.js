// Run attendance on its own:  ATTENDANCE_ADMIN_KEY=... node attendance/standalone.js
import express from "express";
import { createAttendanceRouter } from "./index.js";

const PORT = process.env.PORT || 3100;
const app = express();
app.set("trust proxy", 1);
app.use("/", await createAttendanceRouter());
app.listen(PORT, () => console.log(`Vayal Attendance on :${PORT}  (employees: /   HR: /hr)${process.env.ATTENDANCE_ADMIN_KEY ? "" : "  - set ATTENDANCE_ADMIN_KEY to enable HR sign-in"}`));
