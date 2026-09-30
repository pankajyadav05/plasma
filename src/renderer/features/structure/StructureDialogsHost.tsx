import { ImportDialog } from '@/features/import/ImportDialog';
import { CreateTableDialog } from './CreateTableDialog';
import { CreateViewDialog } from './CreateViewDialog';

/** Mounted once (AppShell overlays): create table / view and import. */
export function StructureDialogsHost() {
  return (
    <>
      <CreateTableDialog />
      <CreateViewDialog />
      <ImportDialog />
    </>
  );
}
