import {
  forwardRef,
  useRef,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertDialog,
  Dialog,
  DropdownMenu,
  Select,
  Switch,
  Tooltip,
} from "radix-ui";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    compact?: boolean;
  }
>(function Button(
  {
    variant = "secondary",
    compact,
    className = "",
    children,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`button ${variant} ${compact ? "compact" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
});

export function Tip({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  showTooltip = true,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  showTooltip?: boolean;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={`icon-button ${className}`}
      {...props}
    >
      {children}
    </button>
  );
  return showTooltip ? <Tip label={label}>{button}</Tip> : button;
}

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "green" | "amber" | "blue" | "red";
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

export interface Option {
  value: string;
  label: string;
  detail?: string;
}
export function Picker({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger className="select-trigger" aria-label={label}>
        <Select.Value placeholder={placeholder} />
        <Select.Icon>
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="select-content"
          position="popper"
          sideOffset={5}
          collisionPadding={12}
        >
          <Select.ScrollUpButton className="select-scroll">
            ⌃
          </Select.ScrollUpButton>
          <Select.Viewport>
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="select-item"
              >
                <div>
                  <Select.ItemText>{o.label}</Select.ItemText>
                  {o.detail && (
                    <span className="select-detail">{o.detail}</span>
                  )}
                </div>
                <Select.ItemIndicator>
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll">
            ⌄
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="toggle-row">
      <span>
        <span className="toggle-label">{label}</span>
        {description && (
          <span className="toggle-description">{description}</span>
        )}
      </span>
      <Switch.Root
        className="switch"
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
    </label>
  );
}

export function Field({
  label,
  children,
  hint,
  error,
  htmlFor,
  optional,
  className = "",
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: string;
  htmlFor?: string;
  optional?: boolean;
  className?: string;
}) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={htmlFor}>
        {label}
        {optional && <span className="optional">Optional</span>}
      </label>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </div>
  );
}

export function Menu({
  trigger,
  items,
}: {
  trigger: ReactElement;
  items: {
    label: string;
    onSelect: () => void;
    icon?: ReactNode;
    danger?: boolean;
    divider?: boolean;
  }[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-content"
          align="end"
          sideOffset={7}
          collisionPadding={12}
        >
          {items.map((item, i) => (
            <div key={item.label}>
              {item.divider && i > 0 && (
                <DropdownMenu.Separator className="menu-separator" />
              )}
              <DropdownMenu.Item
                className={`menu-item ${item.danger ? "danger-text" : ""}`}
                onSelect={item.onSelect}
              >
                {item.icon}
                <span>{item.label}</span>
              </DropdownMenu.Item>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`dialog ${wide ? "wide" : ""}`}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            (returnFocusRef?.current ?? returnFocus.current)?.focus();
          }}
        >
          <div className="dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className={description ? "muted" : "sr-only"}>
                {description || title}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close dialog" showTooltip={false}>
                <X size={17} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Confirm({
  open,
  title,
  description,
  onCancel,
  onDiscard,
  onSave,
  saveLabel = "Save and close",
  discardLabel = "Discard changes",
  cancelLabel = "Keep editing",
}: {
  open: boolean;
  title: string;
  description: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave?: () => void;
  saveLabel?: string;
  discardLabel?: string;
  cancelLabel?: string;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(v) => !v && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="confirm-overlay" />
        <AlertDialog.Content className="confirm-dialog">
          <div className="confirm-emblem">
            <span>↗</span>
          </div>
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          <div className="confirm-actions">
            <AlertDialog.Cancel asChild>
              <Button onClick={onCancel}>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button variant="ghost" onClick={onDiscard}>
              {discardLabel}
            </Button>
            {onSave && (
              <Button variant="primary" onClick={onSave}>
                {saveLabel}
                <ChevronRight size={14} />
              </Button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </header>
  );
}
