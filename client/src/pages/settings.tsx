import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Save, ShieldAlert, Server, HardDrive } from "lucide-react";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const [formData, setFormData] = useState(settings || {
    jdUrl: "",
    jdUser: "",
    jdDevice: "",
    checkInterval: 15,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast({
        title: "Configuration Saved",
        description: "Daemon will reload with new settings automatically.",
      });
    },
  });

  const handleSave = () => {
    updateSettingsMutation.mutate(formData);
  };

  // Update form data when settings load
  if (settings && formData.jdUrl === "" && settings.jdUrl !== "") {
    setFormData(settings);
  }

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div className="mb-8">
        <h2 className="text-3xl font-display font-bold text-white mb-2">Configuration</h2>
        <p className="text-muted-foreground">Manage global settings and API connections.</p>
      </div>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle className="font-display">JDownloader 2 API</CardTitle>
          </div>
          <CardDescription>
            Connection details for your JDownloader instance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label htmlFor="jdUrl">API Endpoint URL</Label>
            <Input 
              id="jdUrl" 
              value={formData.jdUrl}
              onChange={(e) => setFormData({ ...formData, jdUrl: e.target.value })}
              className="bg-background/50 rounded-none border-input font-mono"
              data-testid="input-jd-url"
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="jdUser">MyJDownloader Email</Label>
              <Input 
                id="jdUser" 
                value={formData.jdUser}
                onChange={(e) => setFormData({ ...formData, jdUser: e.target.value })}
                className="bg-background/50 rounded-none border-input"
                data-testid="input-jd-user"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="jdDevice">Device Name</Label>
              <Input 
                id="jdDevice" 
                value={formData.jdDevice}
                onChange={(e) => setFormData({ ...formData, jdDevice: e.target.value })}
                className="bg-background/50 rounded-none border-input"
                data-testid="input-jd-device"
              />
            </div>
          </div>

          <div className="bg-yellow-500/10 border border-yellow-500/20 p-4 flex gap-3 items-start">
            <ShieldAlert className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="text-sm font-bold text-yellow-500">Security Notice</h4>
              <p className="text-xs text-yellow-500/80">
                In the production version, passwords and API keys should be stored in a separate 
                <code>config.json</code> file or environment variables, not in the frontend state.
                This UI is for demonstration purposes.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-primary" />
            <CardTitle className="font-display">Storage Configuration</CardTitle>
          </div>
          <CardDescription>
            Local storage settings for the single-container deployment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label htmlFor="dbPath">Database Path</Label>
            <Input 
              id="dbPath" 
              value="/data/magscrape.db"
              disabled
              className="bg-secondary/30 rounded-none border-input font-mono text-muted-foreground cursor-not-allowed"
            />
            <p className="text-[10px] text-muted-foreground">
              Using lightweight JSON file storage. No external database container required.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/50 border-border rounded-none">
        <CardHeader>
          <CardTitle className="font-display">Scraper Settings</CardTitle>
          <CardDescription>
            Control how often feeds are checked for new content.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label htmlFor="interval">Global Check Interval (minutes)</Label>
            <div className="flex items-center gap-4">
              <Input 
                id="interval" 
                type="number" 
                min="1"
                value={formData.checkInterval}
                onChange={(e) => setFormData({ ...formData, checkInterval: parseInt(e.target.value) || 15 })}
                className="bg-background/50 rounded-none border-input w-32 font-mono"
                data-testid="input-check-interval"
              />
              <span className="text-sm text-muted-foreground">
                Recommended: 15-60 minutes to avoid rate limiting.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button 
          onClick={handleSave} 
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-none px-8"
          disabled={updateSettingsMutation.isPending}
          data-testid="button-save-settings"
        >
          <Save className="mr-2 h-4 w-4" />
          {updateSettingsMutation.isPending ? "Saving..." : "Save Configuration"}
        </Button>
      </div>
    </div>
  );
}
