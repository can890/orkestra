import type { ComboboxRootChangeEventDetails } from '@base-ui/react/combobox';
import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { Combobox } from '@orkestra/ui/react/primitives';
import { ChevronDown } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useMemo, useState } from 'react';
import {
  canInstallAgentOption,
  isComboboxOptionDisabled,
  type AgentDisableReason,
  type AgentGroup,
  type AgentOption,
} from '@core/features/agents/api/browser/components/agent-selector/agent-selector-options';
import { useAgentAvailability } from '@core/features/agents/api/browser/components/agent-selector/use-agent-availability';
import {
  AgentHoverCard,
  isEventInsideAgentHoverCard,
  useAgentHoverCard,
} from '@core/features/agents/browser/components/agent-selector/agent-hover-card';
import { AgentCapabilityIcons } from '@core/features/agents/contributions/browser/agent-capability-icons';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { ORCHESTRA_AGENT_ID } from '@core/features/orchestra/api/orchestra';
import { cn } from '@core/primitives/styling/browser/cn';

interface AgentSelectorProps {
  value: AgentProviderId | null;
  onChange: (agent: AgentProviderId) => void;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  connectionId?: string;
  getDisabledReason?: AgentDisableReason;
  installable?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Verilirse listenin en üstünde sanal "Orkestra" girdisi gösterilir. */
  orchestra?: { disabledReason?: string | null };
}

const ORCHESTRA_GROUP_LABEL = 'Orchestra';
const ORCHESTRA_OPTION_LABEL = 'Orkestra';
const ORCHESTRA_OPTION_DESCRIPTION = 'All agents together, led by a decision-maker';

export const AgentSelector: React.FC<AgentSelectorProps> = observer(
  ({
    value,
    onChange,
    disabled = false,
    className = '',
    contentClassName,
    connectionId,
    getDisabledReason,
    installable = true,
    autoFocus = false,
    placeholder = 'No agent installed',
    orchestra,
  }) => {
    const [open, setOpen] = useState(false);
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
    const hoverCard = useAgentHoverCard();
    const { groups: agentGroups } = useAgentAvailability({
      connectionId,
      getDisabledReason,
      value,
    });
    const orchestraDisabledReason = orchestra?.disabledReason ?? undefined;
    const groups = useMemo<AgentGroup[]>(
      () =>
        orchestra
          ? [
              {
                value: 'orchestra',
                label: ORCHESTRA_GROUP_LABEL,
                items: [
                  {
                    value: ORCHESTRA_AGENT_ID,
                    label: ORCHESTRA_OPTION_LABEL,
                    agentId: ORCHESTRA_AGENT_ID as AgentProviderId,
                    disabled: Boolean(orchestraDisabledReason),
                    disabledReason: orchestraDisabledReason,
                    canInstall: false,
                    supportsAcp: true,
                  },
                ],
              },
              ...agentGroups,
            ]
          : agentGroups,
      [agentGroups, orchestra, orchestraDisabledReason]
    );
    const allOptions = useMemo(() => groups.flatMap((group) => group.items), [groups]);

    const selectedOption = value ? allOptions.find((o) => o.value === value) : null;

    function handleOpenChange(next: boolean, eventDetails: ComboboxRootChangeEventDetails) {
      if (disabled) return;
      // Clicks/focus inside the hover card register as outside presses on the combobox;
      // they must not dismiss the agent list (which would unmount the card too).
      if (!next && hoverCard.open && isEventInsideAgentHoverCard(eventDetails.event, anchorEl)) {
        eventDetails.cancel();
        return;
      }
      if (!next) hoverCard.close();
      setOpen(next);
    }

    function handleValueChange(item: AgentOption | null) {
      if (!item || disabled || item.disabled) return;
      hoverCard.close();
      onChange(item.agentId);
      setOpen(false);
    }

    return (
      <Combobox.Root
        items={groups}
        value={selectedOption ?? null}
        onValueChange={handleValueChange}
        open={open}
        onOpenChange={disabled ? undefined : handleOpenChange}
        isItemEqualToValue={(a: AgentOption, b: AgentOption) => a.value === b.value}
        filter={(item: AgentOption, query) =>
          item.label.toLowerCase().includes(query.toLowerCase())
        }
        autoHighlight
      >
        <Combobox.Trigger
          data-autofocus={autoFocus || undefined}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-transparent px-2.5 py-1 text-sm outline-none',
            disabled && 'cursor-not-allowed opacity-60',
            className
          )}
        >
          {value ? (
            <>
              <AgentIcon id={value} size={16} className="rounded-sm" />
              <span className="flex-1 truncate text-left">{selectedOption?.label ?? value}</span>
            </>
          ) : (
            <span className="flex-1 truncate text-foreground-muted">{placeholder}</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
        </Combobox.Trigger>
        <Combobox.Content
          ref={setAnchorEl}
          className={cn('min-w-(--anchor-width)', contentClassName)}
        >
          <Combobox.Input showTrigger={false} placeholder="Search agents..." />
          <Combobox.List className="pb-0">
            {(group: AgentGroup) => (
              <Combobox.Group key={group.value} items={group.items} className="py-1">
                <Combobox.Label>{group.label}</Combobox.Label>
                <Combobox.Collection>
                  {(item: AgentOption) => {
                    const showInstall = canInstallAgentOption(item, installable);
                    const isOrchestra = item.agentId === ORCHESTRA_AGENT_ID;
                    return (
                      <Combobox.Item
                        key={item.value}
                        value={item}
                        disabled={isComboboxOptionDisabled(item)}
                        hoverableWhenDisabled={item.disabled}
                        className={cn(
                          'group/agent-row',
                          showInstall && 'data-disabled:opacity-100'
                        )}
                        {...(isOrchestra ? {} : hoverCard.getRowHoverProps(item.agentId))}
                      >
                        <AgentIcon
                          id={item.agentId}
                          size={16}
                          className={cn('rounded-sm', showInstall && 'opacity-50')}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn('block truncate', showInstall && 'text-foreground-muted')}
                          >
                            {item.label}
                          </span>
                          {item.disabledReason ? (
                            <span className="block truncate text-xs text-foreground-muted">
                              {item.disabledReason}
                            </span>
                          ) : isOrchestra ? (
                            <span className="block truncate text-xs text-foreground-muted">
                              {ORCHESTRA_OPTION_DESCRIPTION}
                            </span>
                          ) : null}
                        </span>
                        {isOrchestra ? null : (
                          <AgentCapabilityIcons supportsChatUi={item.supportsAcp} />
                        )}
                      </Combobox.Item>
                    );
                  }}
                </Combobox.Collection>
              </Combobox.Group>
            )}
          </Combobox.List>
        </Combobox.Content>
        <AgentHoverCard anchor={anchorEl} controller={hoverCard} connectionId={connectionId} />
      </Combobox.Root>
    );
  }
);
