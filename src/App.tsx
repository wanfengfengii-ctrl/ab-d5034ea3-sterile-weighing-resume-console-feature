import { useEffect, useState } from 'react';
import {
  Journal,
  SimulatedCrashError,
  StableConfirmationRejectedError,
  type JournalSnapshot,
} from './persistence/journal';
import { parseRecipeText, type Recipe, type RecipeError } from './domain/recipe';
import { checkWeighingInput } from './domain/weighing';
import {
  describeStableFailure,
  evaluateReadings,
  isValidReadingSequence,
} from './domain/stable';
import ImportView from './ui/ImportView';
import PreviewView from './ui/PreviewView';
import BatchView from './ui/BatchView';

type View = 'loading' | 'import' | 'preview' | 'batch' | 'crashed';

declare global {
  interface Window {
    /** verify（e2e 测试）可调用的故障钩子入口；每次启动由 App 重新注册。 */
    __verify?: {
      armAfterPrepare: () => void;
      armAfterCommit: () => void;
    };
  }
}

export default function App() {
  const [journal, setJournal] = useState<Journal | null>(null);
  const [snapshot, setSnapshot] = useState<JournalSnapshot | null>(null);
  const [view, setView] = useState<View>('loading');
  const [pendingRecipe, setPendingRecipe] = useState<Recipe | null>(null);
  const [importErrors, setImportErrors] = useState<RecipeError[]>([]);
  const [weighError, setWeighError] = useState<string | null>(null);
  const [stableErrors, setStableErrors] = useState<string[] | null>(null);
  const [crashHook, setCrashHook] = useState<string | null>(null);

  // 启动：打开持久层并执行恢复；界面状态完全由恢复出的已提交前缀派生。
  useEffect(() => {
    let cancelled = false;
    let opened: Journal | null = null;
    Journal.open()
      .then((j) => {
        if (cancelled) {
          j.close();
          return;
        }
        opened = j;
        window.__verify = {
          armAfterPrepare: () => j.armFault('afterPrepare'),
          armAfterCommit: () => j.armFault('afterCommit'),
        };
        setJournal(j);
        setSnapshot(j.snapshot);
        setView(j.snapshot.recipe ? 'batch' : 'import');
      })
      .catch((err: unknown) => {
        console.error('无法打开持久层', err);
        if (!cancelled) {
          setCrashHook(null);
          setView('crashed');
        }
      });
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, []);

  // 导入：校验全部错误一次返回；有任何错误则批次不得开始。
  const handleImport = (text: string) => {
    const { recipe, errors } = parseRecipeText(text);
    setImportErrors(errors);
    if (recipe) {
      setPendingRecipe(recipe);
      setView('preview');
    }
  };

  // 开始批次：配方落盘，之后不可替换。
  const handleStart = async () => {
    if (!journal || !pendingRecipe) return;
    try {
      await journal.startBatch(pendingRecipe);
    } catch (err) {
      setImportErrors([
        { stepIndex: null, field: null, message: err instanceof Error ? err.message : String(err) },
      ]);
      setView('import');
      return;
    }
    setSnapshot(journal.snapshot);
    setPendingRecipe(null);
    setWeighError(null);
    setStableErrors(null);
    setView('batch');
  };

  // 单次称量确认（未声明 stable 的旧流程）：先本地校验（失败时步骤与日志均不改变），
  // 再走两阶段写入；提交标记成功后才更新界面。
  const handleConfirm = async (barcodeInput: string, doseInput: string) => {
    if (!journal || !snapshot?.recipe) return;
    const step = snapshot.recipe.steps[snapshot.applied.length];
    if (!step) return;
    const check = checkWeighingInput(step, barcodeInput, doseInput);
    if (!check.ok) {
      setWeighError(check.reason);
      return;
    }
    try {
      await journal.confirmExpected(check.doseMg);
      setSnapshot(journal.snapshot);
      setWeighError(null);
    } catch (err) {
      if (err instanceof SimulatedCrashError) {
        setCrashHook(err.hook);
        setView('crashed');
      } else {
        setWeighError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  // 稳定读数确认：条码须为当前原料；候选剂量完全由领域层依据读数重算，
  // 调用方不提供剂量。不足 N 项、极差、趋势、剂量区间失败按固定顺序
  // 同时反馈，且不产生任何写入。
  const handleConfirmStable = async (barcodeInput: string, readings: number[]) => {
    if (!journal || !snapshot?.recipe) return;
    const step = snapshot.recipe.steps[snapshot.applied.length];
    if (!step || !step.stable) return;
    if (barcodeInput !== step.barcode) {
      setStableErrors(['条码与当前原料不一致，请扫描当前步骤的原料条码']);
      return;
    }
    if (!isValidReadingSequence(readings)) {
      setStableErrors(['读数证据非法：每项须为非负安全整数毫克']);
      return;
    }
    try {
      await journal.confirmStable(readings);
      setSnapshot(journal.snapshot);
      setStableErrors(null);
    } catch (err) {
      if (err instanceof SimulatedCrashError) {
        setCrashHook(err.hook);
        setView('crashed');
        return;
      }
      if (err instanceof StableConfirmationRejectedError) {
        // 重新计算失败明细，按领域层固定顺序给出实际值/配置值；
        // 证据本身非法时无法重算，仅展示拒绝原因。
        if (!isValidReadingSequence(err.readings)) {
          setStableErrors([err.message]);
          return;
        }
        const detail = evaluateReadings(step, err.readings);
        const messages = detail.ok
          ? [err.message]
          : detail.failures.map((kind) => describeStableFailure(kind, step, detail));
        setStableErrors(messages);
        return;
      }
      setStableErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  return (
    <main>
      <header className="app-header">
        <h1>无菌配液称量工作台</h1>
        <p className="subtitle">纯前端 · 仅 IndexedDB 持久化 · 两阶段写入（预备记录 → 提交标记）</p>
      </header>

      {view === 'loading' && <p data-testid="loading">正在恢复批次状态…</p>}

      {view === 'crashed' && (
        <section data-testid="crash-banner" className="crash-banner" role="alert">
          <h2>
            模拟崩溃{crashHook ? `（${crashHook} 钩子）` : ''}
          </h2>
          <p>故障钩子触发，进程已立即终止；本次确认未反映到界面。</p>
          <p>
            刷新页面后，恢复流程会删除无提交标记的悬空预备记录，并从序号 1
            起重放预备记录与提交标记齐全的最长连续前缀。
          </p>
          <button data-testid="reload-button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </section>
      )}

      {view === 'import' && <ImportView errors={importErrors} onImport={handleImport} />}

      {view === 'preview' && pendingRecipe && (
        <PreviewView
          recipe={pendingRecipe}
          onStart={handleStart}
          onBack={() => setView('import')}
        />
      )}

      {view === 'batch' && snapshot?.recipe && (
        <BatchView
          recipe={snapshot.recipe}
          applied={snapshot.applied}
          weighError={weighError}
          stableErrors={stableErrors}
          onConfirm={handleConfirm}
          onConfirmStable={handleConfirmStable}
          onClearStableErrors={() => setStableErrors(null)}
        />
      )}
    </main>
  );
}
