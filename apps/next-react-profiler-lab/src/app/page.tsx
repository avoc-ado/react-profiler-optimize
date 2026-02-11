import styles from "./page.module.css";
import { ProfilerLab } from "@/components/ProfilerLab";

export default function Home() {
  return (
    <div className={styles.page}>
      <ProfilerLab />
    </div>
  );
}
