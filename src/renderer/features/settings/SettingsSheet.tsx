import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSession } from '@/stores/session';
import { SettingsBody } from './SettingsBody';

export function SettingsSheet() {
  const open = useSession((s) => s.settingsOpen);
  const setOpen = useSession((s) => s.setSettingsOpen);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader className="px-0">
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Preferences persist in the local SQLite store.</SheetDescription>
        </SheetHeader>
        <SettingsBody />
      </SheetContent>
    </Sheet>
  );
}
